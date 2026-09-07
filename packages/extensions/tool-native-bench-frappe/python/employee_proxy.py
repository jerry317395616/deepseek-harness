"""Opt-in employee HTTP/WebSocket proxy; TLS and runtime provisioning stay external.

The gateway owns immutable identity routing. Each request and active stream also
requires a live account check. Closing transport cannot roll back accepted work.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from aiohttp import ClientSession, ClientTimeout, DummyCookieJar, WSMsgType, web

from employee_gateway import (
    COOKIE_NAME, Configuration, EmployeeGateway, MAX_TICKET_BYTES, private_bytes,
)

HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
}
SECURITY_HEADERS = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}


def filtered_headers(headers, *, response=False):
    """Remove hop headers and employee credentials before crossing upstream."""
    connection = {part.strip().lower()
                  for value in headers.getall("Connection", [])
                  for part in value.split(",")}
    return [(key, value) for key, value in headers.items()
            if key.lower() not in HOP_HEADERS | connection
            and (response or key.lower() not in {
                "authorization", "origin", "forwarded",
            } and not key.lower().startswith("x-forwarded-"))]


class EmployeeProxy:
    """Own upstream sessions, authorization deadlines and stream task cleanup.

    account_enabled is a trusted async boolean lookup, never model code. It must
    be cancellation-safe. Authorization failures deny access without diagnostics
    containing request URLs, cookies, tickets or account records.
    """

    def __init__(self, gateway, account_enabled, *, recheck_seconds, check_seconds):
        if not 0 < recheck_seconds <= 30 or not 0 < check_seconds <= 30:
            raise ValueError("proxy authorization deadlines must be within 30 seconds")
        self.gateway = gateway
        self.account_enabled = account_enabled
        self.recheck_seconds = recheck_seconds
        self.check_seconds = check_seconds
        self.client = None
        self.streams = {}
        self.app = web.Application(client_max_size=1024 * 1024)
        self.app.router.add_route("*", "/{path:.*}", self.handle)
        self.app.cleanup_ctx.append(self.lifecycle)
        self.app.on_shutdown.append(self.shutdown)

    async def lifecycle(self, _app):
        async with ClientSession(
            cookie_jar=DummyCookieJar(), trust_env=False,
            timeout=ClientTimeout(total=30), auto_decompress=False,
        ) as client:
            self.client = client
            yield
            self.client = None

    async def shutdown(self, _app):
        tasks = tuple(self.streams)
        for stop in self.streams.values():
            stop.set()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def allowed(self, cookie):
        binding = self.gateway.authorize(cookie)
        if binding is None:
            return None
        try:
            async with asyncio.timeout(self.check_seconds):
                enabled = await self.account_enabled(binding.user)
        except Exception:
            self.gateway.logout(cookie)
            return None  # A failed or timed-out identity dependency revokes this login.
        # Logout or expiry during the account lookup must not revive the session.
        if enabled is not True:
            self.gateway.logout(cookie)
            return None
        if self.gateway.authorize(cookie) != binding:
            return None
        return binding

    @staticmethod
    def reply(status, **headers):
        return web.Response(status=status, headers={**SECURITY_HEADERS, **headers})

    async def handle(self, request):
        origin = self.gateway.config.public_origin
        if request.host != urlsplit(origin).netloc:
            return self.reply(403)
        if len(request.raw_path) > MAX_TICKET_BYTES + 128:
            return self.reply(400)
        cookies = request.headers.getall("Cookie", [])
        cookie = cookies[0] if len(cookies) == 1 else ""
        if request.path == "/health":
            return self.reply(204) if request.method == "GET" else self.reply(405)
        if request.path == "/auth":
            return self.reply(404)  # Routing metadata is never a public API.
        if request.path == "/logout":
            if request.method != "POST" or request.headers.getall("Origin", []) != [origin]:
                return self.reply(403)
            self.gateway.logout(cookie)
            return self.reply(204, **{"Set-Cookie":
                f"{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"})
        if request.path == "/sso":
            if request.method != "GET":
                return self.reply(405)
            try:
                query = parse_qs(request.query_string, strict_parsing=True, max_num_fields=2)
                if set(query) != {"token"} or len(query["token"]) != 1:
                    raise ValueError("invalid handoff")
                value, target = self.gateway.exchange(query["token"][0])
                session_cookie = f"{COOKIE_NAME}={value}"
                if await self.allowed(session_cookie) is None:
                    self.gateway.logout(session_cookie)
                    return self.reply(401)
            except (ValueError, TypeError, KeyError, OSError, UnicodeError):
                return self.reply(401)
            return self.reply(303, Location=target, **{"Set-Cookie":
                f"{session_cookie}; Path=/; Max-Age={self.gateway.config.session_seconds}; "
                "HttpOnly; Secure; SameSite=Lax"})
        if (request.method not in {"GET", "HEAD"}
                or request.headers.get("Upgrade", "").lower() == "websocket"):
            if request.headers.getall("Origin", []) != [origin]:
                return self.reply(403)
        binding = await self.allowed(cookie)
        if binding is None:
            return self.reply(401)
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return await self.websocket(request, binding, cookie)
        headers = filtered_headers(request.headers)
        # The employee login cookie must not reach the single-user Harness host.
        headers = [(k, v) for k, v in headers if k.lower() != "cookie"]
        native_cookie = "; ".join(part.strip() for part in cookie.split(";")
                                  if part.strip().partition("=")[0] != COOKIE_NAME)
        if native_cookie:
            headers.append(("Cookie", native_cookie))
        headers.append(("Origin", binding.upstream))
        try:
            body = await request.read()
            async with self.client.request(
                request.method, binding.upstream + request.raw_path, headers=headers,
                data=body, allow_redirects=False,
            ) as upstream:
                # Recheck before releasing data; no background request may return
                # records after logout/disable while its response is in flight.
                payload = bytearray()
                async for chunk in upstream.content.iter_chunked(65536):
                    payload.extend(chunk)
                    if len(payload) > 16 * 1024 * 1024:
                        break
                if len(payload) > 16 * 1024 * 1024:
                    return self.reply(502)
                if await self.allowed(cookie) != binding:
                    return self.reply(401)
                response_headers = filtered_headers(upstream.headers, response=True)
                response_headers = [(k, v) for k, v in response_headers
                                    if k.lower() not in {"cache-control", "referrer-policy"}]
                response_headers.extend(SECURITY_HEADERS.items())
                return web.Response(status=upstream.status, body=payload, headers=response_headers)
        except web.HTTPRequestEntityTooLarge:
            return self.reply(413)
        except (OSError, asyncio.TimeoutError):
            return self.reply(502)
        except Exception:
            return self.reply(502)  # Transport/library failures must not echo URLs.

    async def websocket(self, request, binding, cookie):
        if request.path != "/api/remote.mux" or request.query_string:
            return self.reply(404)
        native_cookie = "; ".join(part.strip() for part in cookie.split(";")
                                  if part.strip().partition("=")[0] != COOKIE_NAME)
        try:
            upstream = await self.client.ws_connect(
                binding.upstream + request.path, origin=binding.upstream,
                headers={"Cookie": native_cookie}, max_msg_size=1024 * 1024,
                autoping=True,
            )
        except Exception:
            return self.reply(502)  # No upstream response or URL is exposed.
        downstream = web.WebSocketResponse(max_msg_size=1024 * 1024, autoping=True)
        tasks = []
        owner = asyncio.current_task()
        stop = asyncio.Event()
        self.streams[owner] = stop
        try:
            if await self.allowed(cookie) != binding:
                return self.reply(401)
            await downstream.prepare(request)

            async def relay(source, destination):
                async for message in source:
                    if message.type not in {WSMsgType.TEXT, WSMsgType.BINARY}:
                        break
                    if await self.allowed(cookie) != binding:
                        break
                    if message.type == WSMsgType.TEXT:
                        await destination.send_str(message.data)
                    else:
                        await destination.send_bytes(message.data)

            async def monitor():
                while await self.allowed(cookie) == binding:
                    await asyncio.sleep(self.recheck_seconds)

            tasks = [
                asyncio.create_task(relay(downstream, upstream)),
                asyncio.create_task(relay(upstream, downstream)),
                asyncio.create_task(monitor()),
                asyncio.create_task(stop.wait()),
            ]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            # Bound the close handshake; cancellation still awaits both sockets.
            async def close(socket):
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(2):
                        await socket.close(code=1008)
            try:
                await asyncio.gather(close(upstream), close(downstream))
            finally:
                self.streams.pop(owner, None)
        return downstream


class NativeAccountChecks:
    """Invoke the existing trusted identity verifier with immutable config paths."""

    def __init__(self, python, configurations):
        self.python = python
        self.configurations = configurations
        # A remote client cannot create an unbounded number of Bench processes.
        self.slots = asyncio.Semaphore(4)

    async def __call__(self, user):
        async with self.slots:
            return await self.check(user)

    async def check(self, user):
        path = self.configurations.get(user)
        if path is None:
            return False
        env = {key: value for key, value in os.environ.items()
               if key in {"PATH", "LANG", "LC_ALL", "HOME"}}
        process = await asyncio.create_subprocess_exec(
            self.python, "-B", str(Path(__file__).with_name("native_actor_refresh.py")),
            "--config", path, "--check",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, env=env,
        )
        try:
            return await process.wait() == 0
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()


def main():
    parser = argparse.ArgumentParser(description="Loopback employee traffic proxy")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        raw = json.loads(private_bytes(args.config, 65536))
        if set(raw) != {"gateway_config", "python", "identity_configs",
                        "recheck_seconds", "check_seconds"}:
            raise ValueError("invalid proxy configuration")
        config = Configuration.load(raw["gateway_config"])
        checks = raw["identity_configs"]
        if not isinstance(checks, dict) or set(checks) != set(config.bindings):
            raise ValueError("every employee requires an identity check")
        # Validate account/site association before startup, not from request input.
        from native_actor_refresh import Configuration as IdentityConfiguration
        for user, path in checks.items():
            identity = IdentityConfiguration.load(path)
            if identity.user != user or identity.site != config.issuer:
                raise ValueError("identity check does not match employee binding")
        python = Path(raw["python"])
        if not python.is_absolute() or not python.is_file():
            raise ValueError("invalid identity interpreter")
        proxy = EmployeeProxy(EmployeeGateway(config), NativeAccountChecks(str(python), checks),
                              recheck_seconds=raw["recheck_seconds"],
                              check_seconds=raw["check_seconds"])
    except (ValueError, TypeError, KeyError, OSError):
        parser.exit(2, "employee proxy configuration is unavailable or invalid\n")
    web.run_app(proxy.app, host="127.0.0.1", port=config.port, access_log=None, print=None)


if __name__ == "__main__":
    main()
