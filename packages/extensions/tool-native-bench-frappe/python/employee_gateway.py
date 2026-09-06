"""Loopback SSO router for pre-provisioned, single-employee Harness hosts.

This auxiliary process does not launch Harness, issue Frappe assertions, proxy
business traffic, or grant application permissions. The trusted reverse proxy
must authorize every HTTP request and WebSocket upgrade through /auth.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

COOKIE_NAME = "__Host-dsh-employee"
MAX_TICKET_BYTES = 4096
MAX_HANDOFF_SECONDS = 60
BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
UPSTREAM = re.compile(r"^http://127\.0\.0\.1:([1-9][0-9]{0,4})$")


def private_bytes(path: str, limit: int) -> bytes:
    """Read one bounded owner-only POSIX file without following its final link."""
    if os.name != "posix" or not Path(path).is_absolute():
        raise ValueError("gateway requires absolute private POSIX files")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > limit):
            raise ValueError("gateway file must be private, regular, and bounded")
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise ValueError("gateway file exceeds limit")
        return data
    finally:
        os.close(fd)


def b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64decode(value: str) -> bytes:
    if not BASE64URL.fullmatch(value):
        raise ValueError("invalid encoding")
    result = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if b64encode(result) != value:
        raise ValueError("non-canonical encoding")
    return result


def integer(value: object, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise ValueError("invalid integer configuration")
    return value


@dataclass(frozen=True)
class Binding:
    user: str
    upstream: str
    home: Path
    launch_file: str


@dataclass(frozen=True)
class Configuration:
    issuer: str
    public_origin: str
    secret: bytes
    port: int
    session_seconds: int
    max_sessions: int
    bindings: dict[str, Binding]

    @classmethod
    def load(cls, path: str) -> Configuration:
        raw = json.loads(private_bytes(path, 65536))
        if not isinstance(raw, dict) or set(raw) != {
            "version", "issuer", "public_origin", "secret_file", "port",
            "session_seconds", "max_sessions", "bindings",
        } or raw["version"] != 1:
            raise ValueError("invalid gateway configuration")
        issuer = raw["issuer"]
        origin = raw["public_origin"]
        if not isinstance(issuer, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,127}", issuer):
            raise ValueError("invalid issuer")
        if not isinstance(origin, str):
            raise ValueError("invalid public origin")
        parsed = urlsplit(origin)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
                or origin != f"https://{parsed.netloc}" or not origin.isascii()):
            raise ValueError("public origin must be an HTTPS origin")
        secret = private_bytes(raw["secret_file"], 4096).strip()
        if len(secret) < 32:
            raise ValueError("gateway signing key is unavailable")
        rows = raw["bindings"]
        if not isinstance(rows, list) or not 1 <= len(rows) <= 256:
            raise ValueError("explicit employee bindings are required")
        bindings = {}
        upstreams = set()
        homes = []
        launch_values = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"user", "upstream", "home", "launch_file"}:
                raise ValueError("invalid employee binding")
            user = row["user"]
            if (not isinstance(user, str) or not user or len(user) > 254 or user != user.strip()
                    or any(ord(c) < 32 or ord(c) == 127 for c in user)
                    or user.casefold() in {"guest", "administrator"} or user in bindings):
                raise ValueError("invalid or duplicate employee")
            upstream = row["upstream"]
            match = UPSTREAM.fullmatch(upstream) if isinstance(upstream, str) else None
            if not match or int(match[1]) > 65535 or upstream in upstreams:
                raise ValueError("each employee requires a distinct loopback upstream")
            home_arg = Path(row["home"])
            home = home_arg.resolve(strict=True)
            info = home.stat()
            if (not home_arg.is_absolute() or home_arg.is_symlink() or not home.is_dir()
                    or info.st_uid != os.geteuid() or info.st_mode & 0o077
                    or any(home.is_relative_to(other) or other.is_relative_to(home) for other in homes)):
                raise ValueError("each employee requires a distinct private home")
            launch_file = row["launch_file"]
            launch_path = Path(launch_file)
            if not launch_path.is_absolute() or not launch_path.resolve(strict=True).is_relative_to(home):
                raise ValueError("launch credential must belong to the employee home")
            launch = private_bytes(launch_file, MAX_TICKET_BYTES).strip().decode("ascii")
            if not 40 <= len(launch) <= 512 or not BASE64URL.fullmatch(launch) or launch in launch_values:
                raise ValueError("each employee requires a distinct launch credential")
            bindings[user] = Binding(user, upstream, home, launch_file)
            upstreams.add(upstream)
            homes.append(home)
            launch_values.add(launch)
        return cls(issuer, origin, secret, integer(raw["port"], 1024, 65535),
                   integer(raw["session_seconds"], 60, 28800),
                   integer(raw["max_sessions"], 1, 4096), bindings)


class EmployeeGateway:
    """Own bounded login/replay state for one immutable deployment mapping."""

    def __init__(self, config: Configuration, clock=time.time):
        self.config = config
        self.clock = clock
        self.started = clock()
        self.lock = threading.Lock()
        self.sessions: dict[str, tuple[str, float]] = {}
        self.used: dict[str, int] = {}

    def _prune(self, now: float) -> None:
        self.sessions = {key: value for key, value in self.sessions.items() if value[1] > now}
        self.used = {key: expiry for key, expiry in self.used.items() if expiry > now}

    def exchange(self, ticket: str) -> tuple[str, str]:
        """Consume a signed, post-start ticket once; never choose an upstream from input."""
        if not isinstance(ticket, str) or len(ticket) > MAX_TICKET_BYTES:
            raise ValueError("invalid handoff")
        parts = ticket.split(".")
        if len(parts) != 2:
            raise ValueError("invalid handoff")
        body, signature = parts
        expected = hmac.digest(self.config.secret, body.encode("ascii"), "sha256")
        if not hmac.compare_digest(expected, b64decode(signature)):
            raise ValueError("invalid handoff")
        payload = json.loads(b64decode(body))
        if not isinstance(payload, dict) or set(payload) != {"iss", "sub", "iat", "exp", "jti"}:
            raise ValueError("invalid handoff")
        now = self.clock()
        issued = integer(payload["iat"], 0, 2**53 - 1)
        expiry = integer(payload["exp"], 0, 2**53 - 1)
        user = payload["sub"]
        nonce = payload["jti"]
        if (payload["iss"] != self.config.issuer or not isinstance(user, str)
                or user not in self.config.bindings or issued <= self.started or issued > now
                or expiry <= now or not 0 < expiry - issued <= MAX_HANDOFF_SECONDS
                or not isinstance(nonce, str) or not 16 <= len(nonce) <= 128
                or not BASE64URL.fullmatch(nonce)):
            raise ValueError("invalid handoff")
        binding = self.config.bindings[user]
        # Reject rotated/misconfigured shared credentials before issuing a session.
        launch_values = [
            private_bytes(row.launch_file, MAX_TICKET_BYTES).strip().decode("ascii")
            for row in self.config.bindings.values()
        ]
        if (len(set(launch_values)) != len(launch_values)
                or any(not 40 <= len(value) <= 512 or not BASE64URL.fullmatch(value) for value in launch_values)):
            raise ValueError("launch credential is unavailable")
        launch = launch_values[list(self.config.bindings).index(user)]
        with self.lock:
            self._prune(now)
            if nonce in self.used or len(self.used) >= self.config.max_sessions * 4:
                raise ValueError("handoff unavailable")
            if len(self.sessions) >= self.config.max_sessions:
                raise ValueError("session capacity reached")
            cookie = secrets.token_urlsafe(32)
            self.used[nonce] = expiry
            self.sessions[hashlib.sha256(cookie.encode()).hexdigest()] = (
                binding.user, now + self.config.session_seconds,
            )
        return cookie, "/?" + urlencode({"token": launch})

    def authorize(self, raw_cookie: str) -> Binding | None:
        values = []
        if len(raw_cookie) > 16384:
            return None
        for entry in raw_cookie.split(";"):
            name, separator, value = entry.strip().partition("=")
            if separator and name == COOKIE_NAME:
                values.append(value)
        if len(values) != 1 or not BASE64URL.fullmatch(values[0]):
            return None
        with self.lock:
            self._prune(self.clock())
            session = self.sessions.get(hashlib.sha256(values[0].encode()).hexdigest())
        return self.config.bindings[session[0]] if session else None

    def logout(self, raw_cookie: str) -> None:
        # Invalid or ambiguous cookies never select a session for removal.
        if self.authorize(raw_cookie) is None:
            return
        value = next(item.strip().partition("=")[2] for item in raw_cookie.split(";")
                     if item.strip().partition("=")[0] == COOKIE_NAME)
        with self.lock:
            self.sessions.pop(hashlib.sha256(value.encode()).hexdigest(), None)


class EmployeeHTTPServer(ThreadingHTTPServer):
    """Join in-flight requests during shutdown; socket reads have bounded waits."""

    daemon_threads = False
    block_on_close = True


def handler_for(gateway: EmployeeGateway):
    """Build an HTTP adapter whose diagnostics never contain tickets or cookies."""
    class Handler(BaseHTTPRequestHandler):
        server_version = "EmployeeGateway"
        sys_version = ""

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_args):
            pass  # URLs carry credentials; deployment logs must omit query strings.

        def reply(self, status: int, headers: dict[str, str] | None = None):
            self.send_response(status)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Length", "0")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()

        def do_GET(self):
            if len(self.path) > MAX_TICKET_BYTES + 128:
                self.reply(401)
                return
            url = urlsplit(self.path)
            if url.path == "/health":
                self.reply(204)
            elif url.path == "/auth" and not url.query:
                if len(self.headers.get_all("Cookie", [])) != 1:
                    self.reply(401)
                    return
                binding = gateway.authorize(self.headers.get("Cookie", ""))
                if binding is None:
                    self.reply(401)
                else:
                    self.reply(204, {"X-Harness-Upstream": binding.upstream,
                                     "X-Harness-Actor": b64encode(binding.user.encode())})
            elif url.path == "/sso":
                try:
                    query = parse_qs(url.query, strict_parsing=True, max_num_fields=2)
                    if set(query) != {"token"} or len(query["token"]) != 1:
                        raise ValueError("invalid handoff")
                    cookie, target = gateway.exchange(query["token"][0])
                except (ValueError, TypeError, KeyError, OSError, UnicodeError):
                    self.reply(401)
                    return
                self.reply(303, {"Location": target, "Set-Cookie":
                    f"{COOKIE_NAME}={cookie}; Path=/; Max-Age={gateway.config.session_seconds}; "
                    "HttpOnly; Secure; SameSite=Lax"})
            else:
                self.reply(404)

        def do_POST(self):
            if (self.path != "/logout" or self.headers.get("Origin") != gateway.config.public_origin
                    or len(self.headers.get_all("Cookie", [])) != 1):
                self.reply(403)
                return
            gateway.logout(self.headers.get("Cookie", ""))
            self.reply(204, {"Set-Cookie": f"{COOKIE_NAME}=; Path=/; Max-Age=0; "
                        "HttpOnly; Secure; SameSite=Lax"})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="Loopback employee SSO routing service")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        config = Configuration.load(args.config)
    except (ValueError, TypeError, KeyError, OSError):
        parser.exit(2, "employee gateway configuration is unavailable or invalid\n")
    gateway = EmployeeGateway(config)
    with EmployeeHTTPServer(("127.0.0.1", config.port), handler_for(gateway)) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass  # Closing the server joins request threads.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
