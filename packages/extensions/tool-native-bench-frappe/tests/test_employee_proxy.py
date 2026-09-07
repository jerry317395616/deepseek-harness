"""Credential-free transport tests. Install python/requirements-employee-proxy.txt."""

import asyncio
import hashlib
import hmac
import json
import secrets
import sys
import tempfile
import unittest
from pathlib import Path

from aiohttp import ClientSession, DummyCookieJar, WSMsgType, web
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from employee_gateway import Binding, Configuration, COOKIE_NAME, EmployeeGateway, b64encode
from employee_proxy import EmployeeProxy

ORIGIN = "https://employees.example.test"
HEADERS = {"Host": "employees.example.test", "Origin": ORIGIN}


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="employee-proxy-test-")
        self.addCleanup(self.root.cleanup)
        self.now = 100
        self.enabled = {"teacher@example.test": True, "finance@example.test": True}
        self.frames = {}
        self.received = {"teacher@example.test": [], "finance@example.test": []}
        self.waiting = asyncio.Event()
        self.release = asyncio.Event()
        self.fail_check = False
        self.hang_check = False
        bindings = {}
        for user in self.enabled:
            app = web.Application()
            app.router.add_route("*", "/{path:.*}", self.upstream_for(user))
            server = TestServer(app, host="127.0.0.1")
            await server.start_server()
            self.addAsyncCleanup(server.close)
            home = Path(self.root.name, user)
            home.mkdir(mode=0o700)
            launch = home / "launch"
            launch.touch(mode=0o600)
            launch.write_text(secrets.token_urlsafe(32))
            bindings[user] = Binding(user, str(server.make_url("")).rstrip("/"), home, str(launch))
        config = Configuration("example.test", ORIGIN, secrets.token_bytes(32), 12345, 60, 16, bindings)
        self.gateway = EmployeeGateway(config, clock=lambda: self.now)
        self.now += 1

        async def enabled(user):
            if self.fail_check:
                raise RuntimeError("synthetic identity failure")
            if self.hang_check:
                await asyncio.Event().wait()
            return self.enabled.get(user, False)
        self.proxy = EmployeeProxy(self.gateway, enabled, recheck_seconds=0.02, check_seconds=0.1)
        self.server = TestServer(self.proxy.app, host="127.0.0.1", shutdown_timeout=1)
        await self.server.start_server()
        self.addAsyncCleanup(self.server.close)
        self.client = ClientSession(cookie_jar=DummyCookieJar())
        self.addAsyncCleanup(self.client.close)
        self.cookies = {}
        for user in self.enabled:
            response = await self.client.get(self.url("/sso"), params={"token": self.ticket(user)},
                                             headers=HEADERS, allow_redirects=False)
            self.assertEqual(response.status, 303)
            self.cookies[user] = response.headers["Set-Cookie"].split(";", 1)[0]
            response.release()

    def ticket(self, user):
        payload = {"iss": "example.test", "sub": user, "iat": self.now,
                   "exp": self.now + 60, "jti": secrets.token_urlsafe(18)}
        body = b64encode(json.dumps(payload).encode())
        return body + "." + b64encode(hmac.digest(self.gateway.config.secret, body.encode(), "sha256"))

    def url(self, path):
        return self.server.make_url(path)

    def headers(self, user):
        return {**HEADERS, "Cookie": self.cookies[user]}

    def upstream_for(self, user):
        async def upstream(request):
            if request.path == "/api/remote.mux":
                socket = web.WebSocketResponse()
                await socket.prepare(request)
                self.frames[user] = socket
                async for message in socket:
                    if message.type == WSMsgType.TEXT:
                        self.received[user].append(message.data)
                        await socket.send_str(user)
                return socket
            if request.path == "/wait":
                self.waiting.set()
                await self.release.wait()
            self.assertNotIn(COOKIE_NAME + "=", request.headers.get("Cookie", ""))
            return web.json_response({"owner": user})
        return upstream

    async def connect(self, user):
        socket = await self.client.ws_connect(self.url("/api/remote.mux"), headers=self.headers(user))
        self.addAsyncCleanup(socket.close)
        return socket

    async def assert_closed(self, socket):
        message = await asyncio.wait_for(socket.receive(), 3)
        self.assertIn(message.type, {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR})

    async def test_routes_two_users_and_rejects_missing_duplicate_or_cross_origin_auth(self):
        for user in self.enabled:
            async with self.client.get(self.url("/records"), headers=self.headers(user)) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.json(), {"owner": user})
        for headers in [
            HEADERS,
            {**HEADERS, "Cookie": "; ".join(self.cookies.values())},
            {**self.headers("teacher@example.test"), "Host": "hostile.example.test"},
        ]:
            async with self.client.get(self.url("/records"), headers=headers) as response:
                self.assertIn(response.status, {401, 403})
        async with self.client.post(self.url("/records"), headers={
            **self.headers("teacher@example.test"), "Origin": "https://hostile.example.test",
        }) as response:
            self.assertEqual(response.status, 403)
        async with self.client.get(self.url("/auth"), headers=HEADERS) as response:
            self.assertEqual(response.status, 404)

    async def test_logout_closes_idle_stream_without_affecting_other_employee(self):
        teacher = await self.connect("teacher@example.test")
        finance = await self.connect("finance@example.test")
        async with self.client.post(self.url("/logout"), headers=self.headers("teacher@example.test")) as response:
            self.assertEqual(response.status, 204)
        await self.assert_closed(teacher)
        await finance.send_str("still connected")
        self.assertEqual((await asyncio.wait_for(finance.receive(), 3)).data, "finance@example.test")
        async with self.client.get(self.url("/records"), headers=self.headers("teacher@example.test")) as response:
            self.assertEqual(response.status, 401)

    async def test_disabled_account_blocks_both_directions_and_new_connections(self):
        teacher = await self.connect("teacher@example.test")
        self.enabled["teacher@example.test"] = False
        await teacher.send_str("must not arrive")
        await self.assert_closed(teacher)
        self.assertEqual(self.received["teacher@example.test"], [])
        self.enabled["teacher@example.test"] = True  # Revoked cookies cannot revive on re-enable.
        async with self.client.get(self.url("/records"), headers=self.headers("teacher@example.test")) as response:
            self.assertEqual(response.status, 401)
        finance = await self.connect("finance@example.test")
        self.enabled["finance@example.test"] = False
        await self.frames["finance@example.test"].send_str("must not leak")
        await self.assert_closed(finance)

    async def test_expiry_closes_idle_stream(self):
        socket = await self.connect("teacher@example.test")
        self.now += 61
        await self.assert_closed(socket)

    async def test_identity_errors_and_deadlines_fail_closed(self):
        socket = await self.connect("teacher@example.test")
        self.fail_check = True
        await self.assert_closed(socket)
        self.fail_check = False
        self.hang_check = True
        async with self.client.get(self.url("/records"), headers=self.headers("finance@example.test")) as response:
            self.assertEqual(response.status, 401)

    async def test_inflight_http_cannot_return_after_logout(self):
        pending = asyncio.create_task(self.client.get(self.url("/wait"), headers=self.headers("teacher@example.test")))
        try:
            await asyncio.wait_for(self.waiting.wait(), 3)
            self.gateway.logout(self.cookies["teacher@example.test"])
            self.release.set()
            response = await asyncio.wait_for(pending, 3)
            self.assertEqual(response.status, 401)
            response.release()
        finally:
            self.release.set()
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)

    async def test_cli_rejects_missing_configuration_without_request_details(self):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-B", str(Path(__file__).resolve().parents[1] / "python/employee_proxy.py"),
            "--config", str(Path(self.root.name) / "missing.json"),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            async with asyncio.timeout(5):
                stdout, stderr = await process.communicate()
            self.assertEqual(process.returncode, 2)
            self.assertEqual(stdout, b"")
            self.assertEqual(stderr, b"employee proxy configuration is unavailable or invalid\n")
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def test_shutdown_awaits_active_stream_cleanup(self):
        socket = await self.connect("teacher@example.test")
        await self.server.close()
        await self.assert_closed(socket)
        self.assertEqual(self.proxy.streams, {})


if __name__ == "__main__":
    unittest.main()
