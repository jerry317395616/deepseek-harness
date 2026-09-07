"""Account-scoped SSO authority for one shared Harness runtime on Linux.

Only the configured runtime UID may exchange tickets or resolve login sessions.
The runtime receives an identity, never the signing key or Bench credentials.
Scoped reads use the login's pinned Frappe identity and current ORM permissions.
This auxiliary service neither launches Harness nor grants write access.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import socket
import stat
import struct
import sys
import time

from employee_gateway import b64decode, integer, private_bytes
from employee_read_broker import Binding, NativeExecutor, OPERATIONS, bounded_process, strict_json, trusted_directory
from native_actor_refresh import Configuration as IdentityConfiguration
from native_frappe_query import normalize_arguments

LIMIT = 8192
READ_LIMIT = 262144
DENIED = b'{"ok":false}\n'
READ_FIELDS = {
    "frappe_describe_doctype": {"doctype"},
    "frappe_list_documents": {"doctype", "fields", "filters", "order_by", "limit", "start"},
    "frappe_get_document": {"doctype", "name", "fields"},
}


@dataclass(frozen=True)
class Configuration:
    socket_path: Path
    runtime_uid: int
    issuer: str
    secret: bytes
    identities: dict
    session_seconds: int
    max_sessions: int
    max_connections: int
    timeout_seconds: int
    read_doctypes: tuple[str, ...] = ()

    @classmethod
    def load(cls, path):
        if sys.platform != "linux":
            raise ValueError("shared identity requires Linux peer credentials")
        raw = strict_json(private_bytes(path, 65536))
        fields = {"version", "socket_path", "runtime_uid", "issuer", "secret_file",
                  "identity_configs", "session_seconds", "max_sessions",
                  "max_connections", "timeout_seconds", "read_doctypes"}
        if (not isinstance(raw, dict) or set(raw) != fields
                or type(raw["version"]) is not int or raw["version"] != 1):
            raise ValueError("invalid shared identity configuration")
        target = Path(raw["socket_path"])
        if not target.is_absolute() or len(os.fsencode(target)) > 107:
            raise ValueError("invalid socket path")
        trusted_directory(target.parent)
        uid = integer(raw["runtime_uid"], 1, 2**31 - 1)
        pwd.getpwuid(uid)
        if uid == os.geteuid():
            raise ValueError("runtime and authority require different OS users")
        issuer = raw["issuer"]
        if not isinstance(issuer, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,127}", issuer):
            raise ValueError("invalid issuer")
        secret = private_bytes(raw["secret_file"], 4096).strip()
        if len(secret) < 32:
            raise ValueError("signing key unavailable")
        paths = raw["identity_configs"]
        if not isinstance(paths, list) or not 1 <= len(paths) <= 256:
            raise ValueError("explicit account checks required")
        identities = {}
        for source in paths:
            identity = IdentityConfiguration.load(source)
            if (identity.site != issuer or identity.user in identities
                    or uid == identity.bench_root.stat().st_uid):
                raise ValueError("invalid account association")
            identities[identity.user] = (source, identity)
        scope = raw["read_doctypes"]
        if (not isinstance(scope, list) or len(scope) > 64
                or any(not isinstance(name, str) for name in scope)
                or len(set(scope)) != len(scope)):
            raise ValueError("invalid shared read scope")
        for name in scope:
            if normalize_arguments("frappe_describe_doctype", {"doctype": name})["doctype"] != name:
                raise ValueError("invalid shared read scope")
        return cls(target, uid, issuer, secret, identities,
                   integer(raw["session_seconds"], 60, 28800),
                   integer(raw["max_sessions"], 1, 4096),
                   integer(raw["max_connections"], 1, 64),
                   integer(raw["timeout_seconds"], 1, 30), tuple(scope))


@dataclass(frozen=True)
class ReadExecutionLimits:
    operation_seconds: int
    max_input_bytes: int = 16384
    max_output_bytes: int = READ_LIMIT


class NativeRead:
    """Select a pinned employee assertion after login resolution, never by runtime UID."""

    def __init__(self, config):
        self.config = config
        self.executor = NativeExecutor(ReadExecutionLimits(config.timeout_seconds))

    async def __call__(self, user, operation, arguments):
        source, identity = self.config.identities[user]
        binding = Binding(self.config.runtime_uid, source, identity, self.config.read_doctypes)
        result = await self.executor(binding, operation, arguments)
        return result["result"]


class NativeEnabledCheck:
    """Revalidate pinned config and the current Frappe System User through ORM."""

    def __init__(self, config):
        self.config = config

    async def __call__(self, user):
        source, identity = self.config.identities[user]
        if IdentityConfiguration.load(source) != identity:
            return False
        await bounded_process(
            [str(identity.bench_root / "env/bin/python"), "-s", "-B",
             str(Path(__file__).with_name("native_actor_refresh.py")),
             "--config", source, "--check"], b"", cwd=identity.bench_root,
            timeout=self.config.timeout_seconds, output_limit=1024,
        )
        return IdentityConfiguration.load(source) == identity


class SharedIdentity:
    """Single-event-loop login owner; async checks cannot revive revoked logins."""

    def __init__(self, config, enabled, clock=time.time, *, read=None):
        self.config, self.enabled, self.clock = config, enabled, clock
        self.started = clock()
        self.sessions, self.used = {}, {}
        self.read, self.readers = read, set()

    def prune(self):
        now = self.clock()
        self.sessions = {key: row for key, row in self.sessions.items() if row[1] > now}
        self.used = {key: expiry for key, expiry in self.used.items() if expiry > now}

    def ticket_user(self, ticket):
        if not isinstance(ticket, str) or len(ticket) > 4096:
            raise ValueError("invalid ticket")
        body, signature = ticket.split(".")
        if not hmac.compare_digest(hmac.digest(self.config.secret, body.encode("ascii"), "sha256"),
                                   b64decode(signature)):
            raise ValueError("invalid ticket")
        row = strict_json(b64decode(body))
        if not isinstance(row, dict) or set(row) != {"iss", "sub", "iat", "exp", "jti"}:
            raise ValueError("invalid ticket")
        issued = integer(row["iat"], 0, 2**53 - 1)
        expiry = integer(row["exp"], 0, 2**53 - 1)
        nonce, user = row["jti"], row["sub"]
        if (row["iss"] != self.config.issuer or not isinstance(user, str)
                or user not in self.config.identities or issued <= self.started
                or issued > self.clock() or expiry <= self.clock() or not 0 < expiry - issued <= 60
                or not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce)):
            raise ValueError("invalid ticket")
        self.prune()
        if nonce in self.used or len(self.used) >= self.config.max_sessions * 4:
            raise ValueError("ticket unavailable")
        # Reserve before any awaited account lookup: concurrent replay has one winner.
        self.used[nonce] = expiry
        return user, expiry

    async def resolve(self, value):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
            return None
        self.prune()
        key = hashlib.sha256(value.encode()).hexdigest()
        row = self.sessions.get(key)
        if row is None:
            return None
        try:
            enabled = await self.enabled(row[0])
        except Exception:
            enabled = False  # An unavailable account authority denies the login.
        self.prune()
        if enabled is not True or self.sessions.get(key) is not row:
            self.sessions.pop(key, None)
            return None
        return {"site": self.config.issuer, "user": row[0]}

    async def execute(self, request):
        if (not isinstance(request, dict) or set(request) != {"version", "operation", "value"}
                or type(request["version"]) is not int or request["version"] != 1):
            raise ValueError("invalid request")
        operation, value = request["operation"], request["value"]
        if operation == "read":
            if (self.read is None or not isinstance(value, dict)
                    or set(value) != {"credential", "operation", "arguments"}
                    or not isinstance(value["operation"], str) or value["operation"] not in OPERATIONS
                    or not isinstance(value["arguments"], dict)
                    or set(value["arguments"]) - READ_FIELDS[value["operation"]]):
                raise ValueError("invalid shared read")
            arguments = normalize_arguments(value["operation"], value["arguments"])
            if arguments["doctype"] not in self.config.read_doctypes:
                raise ValueError("read outside configured scope")
            principal = await self.resolve(value["credential"])
            if principal is None or principal["user"] in self.readers:
                raise ValueError("read unavailable")
            user = principal["user"]
            self.readers.add(user)
            try:
                result = await self.read(user, value["operation"], arguments)
                # A replacement login for the same user cannot revive this request.
                if await self.resolve(value["credential"]) != principal:
                    raise ValueError("login revoked during read")
                return result
            finally:
                self.readers.remove(user)
        if operation == "login":
            user, expiry = self.ticket_user(value)
            if await self.enabled(user) is not True or expiry <= self.clock():
                raise ValueError("account unavailable")
            self.prune()
            if len(self.sessions) >= self.config.max_sessions:
                raise ValueError("login capacity reached")
            cookie = secrets.token_urlsafe(32)
            self.sessions[hashlib.sha256(cookie.encode()).hexdigest()] = (
                user, self.clock() + self.config.session_seconds,
            )
            return {"cookie": cookie, "maxAge": self.config.session_seconds}
        if operation == "authorize":
            result = await self.resolve(value)
            if result is None:
                raise ValueError("login unavailable")
            return result
        if operation == "logout":
            if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
                raise ValueError("invalid login")
            self.sessions.pop(hashlib.sha256(value.encode()).hexdigest(), None)
            return {}
        raise ValueError("unsupported operation")


class IdentityServer:
    """Bounded Unix requests from one runtime UID; teardown reaps all handlers."""

    def __init__(self, authority):
        self.authority, self.config = authority, authority.config
        self.tasks, self.closing = set(), False

    def accept(self, reader, writer):
        if self.closing or len(self.tasks) >= self.config.max_connections:
            writer.transport.abort()
            return
        task = asyncio.create_task(self.handle(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def handle(self, reader, writer):
        try:
            async with asyncio.timeout(self.config.timeout_seconds):
                peer = writer.get_extra_info("socket").getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                if struct.unpack("3i", peer)[1] != self.config.runtime_uid:
                    raise ValueError("runtime not admitted")
                raw = await reader.readuntil(b"\n")
                if len(raw) > LIMIT or await reader.read(1):
                    raise ValueError("one bounded request required")
                result = await self.authority.execute(strict_json(raw))
                output = json.dumps({"ok": True, "result": result}, ensure_ascii=False).encode() + b"\n"
                if len(output) > READ_LIMIT:
                    raise ValueError("result exceeds limit")
                writer.write(output)
                await writer.drain()
        except Exception:
            try:
                writer.write(DENIED)
                async with asyncio.timeout(self.config.timeout_seconds):
                    await writer.drain()
            except (OSError, TimeoutError, RuntimeError):
                pass  # Disconnected clients receive no private diagnostics.
        finally:
            writer.close()
            try:
                async with asyncio.timeout(self.config.timeout_seconds):
                    await writer.wait_closed()
            except TimeoutError:
                writer.transport.abort()
            except OSError:
                pass  # Peer reset while closing this owned connection.

    @asynccontextmanager
    async def listening(self):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        owned, server = None, None
        try:
            listener.bind(str(self.config.socket_path))
            owned = self.config.socket_path.lstat()
            os.chmod(self.config.socket_path, 0o666)
            listener.setblocking(False)
            server = await asyncio.start_unix_server(self.accept, sock=listener, limit=LIMIT + 1,
                                                     cleanup_socket=False)
            yield self
        finally:
            self.closing = True
            if server is not None:
                server.close()
            listener.close()
            tasks = tuple(self.tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if server is not None:
                await server.wait_closed()
            if owned is not None:
                try:
                    current = self.config.socket_path.lstat()
                    if (stat.S_ISSOCK(current.st_mode)
                            and (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino)):
                        self.config.socket_path.unlink()
                except FileNotFoundError:
                    pass  # An operator already removed the owned listener.


async def serve(config):
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    try:
        async with IdentityServer(SharedIdentity(config, NativeEnabledCheck(config), read=NativeRead(config))).listening():
            print("shared identity authority ready", flush=True)
            await stopped.wait()
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        config = Configuration.load(args.config)
        if not args.check:
            asyncio.run(serve(config))
    except Exception:
        print("shared identity authority unavailable", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
