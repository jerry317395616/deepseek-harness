"""Credential-free employee routing tests; all users, paths and keys are fixtures."""

import base64
import concurrent.futures
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import urlencode

SOURCE = Path(__file__).resolve().parents[1] / "python" / "employee_gateway.py"
spec = importlib.util.spec_from_file_location("employee_gateway", SOURCE)
gateway = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gateway
spec.loader.exec_module(gateway)


class EmployeeGatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dsh-employee-gateway-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key = b"fixture-only-handoff-key-not-a-production-secret"
        self.write("signing.fixture", self.key)
        rows = []
        for index, user in enumerate(["teacher@example.test", "finance@example.test"]):
            home = self.root / f"employee-{index}"
            home.mkdir(mode=0o700)
            launch = home / "launch.fixture"
            launch.write_text(chr(97 + index) * 48)
            launch.chmod(0o600)
            rows.append({"user": user, "upstream": f"http://127.0.0.1:{24001 + index}",
                         "home": str(home), "launch_file": str(launch)})
        self.raw = {"version": 1, "issuer": "child.example.test",
                    "public_origin": "https://staff.example.test",
                    "secret_file": str(self.root / "signing.fixture"), "port": 23091,
                    "session_seconds": 120, "max_sessions": 16, "bindings": rows}
        self.config = self.load()
        self.now = 1000.25
        self.service = gateway.EmployeeGateway(self.config, lambda: self.now)
        self.now = 1001

    def write(self, name, content):
        path = self.root / name
        path.write_bytes(content)
        path.chmod(0o600)
        return str(path)

    def load(self):
        return gateway.Configuration.load(self.write("gateway.fixture.json", json.dumps(self.raw).encode()))

    def ticket(self, user="teacher@example.test", nonce="n" * 24, **changes):
        payload = {"iss": self.config.issuer, "sub": user, "iat": 1001, "exp": 1061, "jti": nonce}
        payload.update(changes)
        body = gateway.b64encode(json.dumps(payload).encode())
        return body + "." + gateway.b64encode(hmac.digest(self.key, body.encode(), "sha256"))

    def cookie(self, value):
        return gateway.COOKIE_NAME + "=" + value

    def test_two_employees_have_distinct_routes_and_launches(self):
        first, first_target = self.service.exchange(self.ticket())
        second, second_target = self.service.exchange(self.ticket("finance@example.test", "b" * 24))
        self.assertNotEqual(first, second)
        self.assertNotEqual(first_target, second_target)
        self.assertEqual(self.service.authorize(self.cookie(first)).upstream, "http://127.0.0.1:24001")
        self.assertEqual(self.service.authorize(self.cookie(second)).upstream, "http://127.0.0.1:24002")
        self.assertIsNone(self.service.authorize(self.cookie(first) + "; " + self.cookie(second)))
        self.assertIsNone(self.service.authorize(self.cookie("forged")))

    def test_tampered_expired_unknown_and_invalid_tickets_fail(self):
        bad = [
            self.ticket()[:-5] + "abcde", self.ticket(exp=1001), self.ticket(iat=1002),
            self.ticket(iat=1000), self.ticket(exp=1062), self.ticket(iat=True),
            self.ticket(iat="1001"), self.ticket(iss="other.example.test"),
            self.ticket(user="unknown@example.test"), self.ticket(user="Administrator"),
            self.ticket(user="Guest"), self.ticket(nonce="short"),
            self.ticket(extra="http://127.0.0.1:9999"), "x" * 4097, "x.y.z",
            "💥.x", self.ticket().replace(".", "=.", 1),
        ]
        for ticket in bad:
            with self.subTest(ticket_length=len(ticket)):
                with self.assertRaises((ValueError, UnicodeError)):
                    self.service.exchange(ticket)
        self.assertEqual(self.service.sessions, {})
        self.assertEqual(self.service.used, {})

    def test_concurrent_replay_succeeds_exactly_once(self):
        ticket = self.ticket()
        def consume(_):
            try:
                self.service.exchange(ticket)
                return 1
            except ValueError:
                return 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(consume, range(24))), 1)

    def test_logout_expiry_and_restart_fail_closed(self):
        first, _ = self.service.exchange(self.ticket())
        second, _ = self.service.exchange(self.ticket("finance@example.test", "b" * 24))
        self.service.logout(self.cookie(first))
        self.assertIsNone(self.service.authorize(self.cookie(first)))
        self.assertIsNotNone(self.service.authorize(self.cookie(second)))
        with self.assertRaises(ValueError):
            self.service.exchange(self.ticket())
        self.now = 1121
        self.assertIsNone(self.service.authorize(self.cookie(second)))
        self.assertEqual(self.service.sessions, {})
        fresh = gateway.EmployeeGateway(self.config, lambda: 1002)
        with self.assertRaises(ValueError):
            fresh.exchange(self.ticket())
        self.assertIsNone(fresh.authorize(self.cookie(second)))

    def test_capacity_refusal_does_not_consume_ticket(self):
        config = gateway.Configuration(**{**self.config.__dict__, "max_sessions": 1})
        service = gateway.EmployeeGateway(config, lambda: self.now)
        self.now = 1002
        cookie, _ = service.exchange(self.ticket(iat=1002, exp=1062))
        other = self.ticket("finance@example.test", "b" * 24, iat=1002, exp=1062)
        with self.assertRaises(ValueError):
            service.exchange(other)
        service.logout(self.cookie(cookie))
        self.assertTrue(service.exchange(other)[0])

    def test_replay_memory_is_bounded_even_after_logout(self):
        config = gateway.Configuration(**{**self.config.__dict__, "max_sessions": 1})
        service = gateway.EmployeeGateway(config, lambda: self.now)
        self.now = 1002
        for number in range(4):
            cookie, _ = service.exchange(self.ticket(nonce=str(number) * 24, iat=1002, exp=1062))
            service.logout(self.cookie(cookie))
        with self.assertRaises(ValueError):
            service.exchange(self.ticket(nonce="x" * 24, iat=1002, exp=1062))
        self.assertEqual(len(service.used), 4)

    def test_shared_runtime_home_or_credential_is_refused(self):
        original = json.loads(json.dumps(self.raw))
        variants = [
            ("upstream", self.raw["bindings"][0]["upstream"]),
            ("home", self.raw["bindings"][0]["home"]),
            ("launch_file", self.raw["bindings"][0]["launch_file"]),
            ("user", self.raw["bindings"][0]["user"]),
            ("user", "Administrator"),
            ("upstream", "https://remote.example.test"),
            ("upstream", "http://127.0.0.1:65536"),
        ]
        for field, value in variants:
            self.raw = json.loads(json.dumps(original))
            self.raw["bindings"][1][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.load()
        self.raw = original
        Path(self.raw["bindings"][1]["launch_file"]).write_text("a" * 48)
        with self.assertRaises(ValueError):
            self.load()
        with self.assertRaises(ValueError):
            self.service.exchange(self.ticket())

    def test_private_file_and_parent_home_requirements(self):
        launch = Path(self.raw["bindings"][0]["launch_file"])
        launch.chmod(0o644)
        with self.assertRaises(ValueError):
            self.load()
        launch.chmod(0o600)
        link = launch.parent / "symlink.fixture"
        link.symlink_to(launch)
        self.raw["bindings"][0]["launch_file"] = str(link)
        with self.assertRaises(OSError):
            self.load()
        self.raw["bindings"][0]["launch_file"] = str(launch)
        hardlink = launch.parent / "hardlink.fixture"
        os.link(launch, hardlink)
        with self.assertRaises(ValueError):
            self.load()
        hardlink.unlink()
        launch.parent.chmod(0o755)
        with self.assertRaises(ValueError):
            self.load()

    def test_config_parser_rejects_unknown_or_unsafe_values(self):
        for field, value in [("session_seconds", True), ("max_sessions", 0),
                             ("port", 80), ("public_origin", "http://staff.example.test"),
                             ("public_origin", "https://staff.example.test/path"),
                             ("bindings", []), ("unexpected", 1)]:
            original = dict(self.raw)
            self.raw[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.load()
            self.raw = original

    def test_real_http_adapter_cookie_scope_and_logout(self):
        server = gateway.EmployeeHTTPServer(("127.0.0.1", 0), gateway.handler_for(self.service))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        def close():
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        self.addCleanup(close)

        def request(method, path, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                connection.request(method, path, headers=headers or {})
                response = connection.getresponse()
                result = response.status, dict(response.getheaders()), response.read()
                return result
            finally:
                connection.close()

        self.assertEqual(request("GET", "/auth")[0], 401)
        login = request("GET", "/sso?" + urlencode({"token": self.ticket()}))
        self.assertEqual(login[0], 303)
        self.assertEqual(login[2], b"")
        self.assertEqual(login[1]["Referrer-Policy"], "no-referrer")
        cookie = login[1]["Set-Cookie"]
        self.assertIn("HttpOnly; Secure; SameSite=Lax", cookie)
        self.assertNotIn("Domain=", cookie)
        cookie = cookie.split(";", 1)[0]
        headers = {"Cookie": cookie, "X-Harness-Upstream": "http://127.0.0.1:9999",
                   "X-Auth-User": "Administrator"}
        auth = request("GET", "/auth", headers)
        self.assertEqual(auth[0], 204)
        self.assertEqual(auth[1]["X-Harness-Upstream"], "http://127.0.0.1:24001")
        self.assertEqual(request("GET", "/sso?" + urlencode({"token": self.ticket()}))[0], 401)
        self.assertEqual(request("GET", "/sso?token=a&token=b")[0], 401)
        self.assertEqual(request("POST", "/logout", headers)[0], 403)
        headers["Origin"] = self.config.public_origin
        self.assertEqual(request("POST", "/logout", headers)[0], 204)
        self.assertEqual(request("GET", "/auth", headers)[0], 401)

    def test_cli_rejects_invalid_configuration_without_leaking_values(self):
        invalid = self.write("invalid.fixture.json", json.dumps({"secret": "fixture-sensitive-value"}).encode())
        result = subprocess.run([sys.executable, str(SOURCE), "--config", invalid],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertNotIn(b"fixture-sensitive-value", result.stderr)
        self.assertNotIn(str(self.root).encode(), result.stderr)


if __name__ == "__main__":
    unittest.main()
