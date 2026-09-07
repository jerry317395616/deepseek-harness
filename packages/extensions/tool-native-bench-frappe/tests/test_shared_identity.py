"""Keyless identity tests: account state is the only substituted external authority."""
import asyncio
from dataclasses import replace
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from shared_identity import Configuration, IdentityServer, SharedIdentity, LIMIT
from employee_gateway import b64encode


class IdentityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dsh-shared-identity-")
        self.addCleanup(self.temp.cleanup)
        self.now = 100
        self.enabled = {"teacher@example.test": True, "finance@example.test": True}
        self.config = Configuration(Path(self.temp.name) / "identity.sock", os.getuid(), "example.test",
                                    b"synthetic-shared-identity-key-00000", {user: None for user in self.enabled},
                                    60, 4, 4, 2)

        async def enabled(user):
            return self.enabled[user]
        self.authority = SharedIdentity(self.config, enabled, lambda: self.now)
        self.now = 101

    def ticket(self, user="teacher@example.test", **overrides):
        row = {"iss": "example.test", "sub": user, "iat": self.now, "exp": self.now + 60,
               "jti": secrets.token_urlsafe(16), **overrides}
        body = b64encode(json.dumps(row).encode())
        return body + "." + b64encode(hmac.digest(self.config.secret, body.encode(), "sha256"))

    async def call(self, operation, value, **extra):
        return await self.authority.execute({"version": 1, "operation": operation, "value": value, **extra})

    async def login(self, user="teacher@example.test"):
        return (await self.call("login", self.ticket(user)))["cookie"]

    async def test_accounts_share_authority_but_not_logins(self):
        a, b = await asyncio.gather(self.login(), self.login("finance@example.test"))
        self.assertNotEqual(a, b)
        self.assertEqual(await self.call("authorize", a), {"site": "example.test", "user": "teacher@example.test"})
        self.assertEqual(await self.call("authorize", b), {"site": "example.test", "user": "finance@example.test"})
        self.assertNotIn(a, self.authority.sessions)
        self.assertIn(hashlib.sha256(a.encode()).hexdigest(), self.authority.sessions)
        await self.call("logout", a)
        with self.assertRaises(ValueError):
            await self.call("authorize", a)
        self.assertEqual((await self.call("authorize", b))["user"], "finance@example.test")

    async def test_replay_is_reserved_before_account_lookup(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def wait_enabled(_user):
            entered.set()
            await release.wait()
            return True
        self.authority.enabled = wait_enabled
        ticket = self.ticket()
        first = asyncio.create_task(self.call("login", ticket))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            with self.assertRaises(ValueError):
                await self.call("login", ticket)
        finally:
            release.set()
            await first

    async def test_logout_during_lookup_cannot_release_identity(self):
        cookie = await self.login()
        entered, release = asyncio.Event(), asyncio.Event()
        async def wait_enabled(_user):
            entered.set()
            await release.wait()
            return True
        self.authority.enabled = wait_enabled
        pending = asyncio.create_task(self.call("authorize", cookie))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            await self.call("logout", cookie)
        finally:
            release.set()
        with self.assertRaises(ValueError):
            await pending

    async def test_disable_revokes_login_even_after_reenable(self):
        cookie = await self.login()
        self.enabled["teacher@example.test"] = False
        with self.assertRaises(ValueError):
            await self.call("authorize", cookie)
        self.enabled["teacher@example.test"] = True
        with self.assertRaises(ValueError):
            await self.call("authorize", cookie)

    async def test_authority_outage_fails_closed(self):
        cookie = await self.login()
        async def unavailable(_user):
            raise RuntimeError("private backend detail")
        self.authority.enabled = unavailable
        self.assertIsNone(await self.authority.resolve(cookie))
        self.assertEqual(self.authority.sessions, {})

    async def test_expiry_and_restart_do_not_restore_cookie_or_old_ticket(self):
        ticket = self.ticket()
        cookie = (await self.call("login", ticket))["cookie"]
        self.now += 60
        with self.assertRaises(ValueError):
            await self.call("authorize", cookie)
        replacement = SharedIdentity(self.config, self.authority.enabled, lambda: self.now)
        self.assertIsNone(await replacement.resolve(cookie))
        with self.assertRaises(ValueError):
            replacement.ticket_user(ticket)

    async def test_forged_ticket_and_request_identity_are_denied(self):
        cookie = await self.login()
        for value in [self.ticket() + "x", self.ticket(iss="other.test"),
                      self.ticket(user="Administrator"), self.ticket(iat=99),
                      self.ticket(exp=self.now + 61), self.ticket(iat=True), self.ticket(jti="short")]:
            with self.assertRaises(ValueError):
                await self.call("login", value)
        with self.assertRaises(ValueError):
            await self.call("authorize", cookie, user="finance@example.test")
        with self.assertRaises(ValueError):
            await self.call("frappe_update_document", cookie)

    async def test_capacity_is_rechecked_after_concurrent_login(self):
        self.authority.config = replace(self.config, max_sessions=1)
        first = await self.login()
        with self.assertRaises(ValueError):
            await self.login("finance@example.test")
        await self.call("logout", first)
        self.assertIn("cookie", await self.call("login", self.ticket("finance@example.test")))

    async def wire(self, payload):
        reader, writer = await asyncio.open_unix_connection(str(self.config.socket_path))
        try:
            writer.write(payload)
            await writer.drain()
            writer.write_eof()
            try:
                return await asyncio.wait_for(reader.read(), 4)
            except ConnectionResetError:
                return b""  # Rejection before consuming peer bytes may reset the stream.
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionResetError:
                pass  # A denied peer owns no accepted operation.

    async def test_unix_transport_rejects_invalid_frames_and_other_uid(self):
        server = IdentityServer(self.authority)
        async with server.listening():
            for raw in [b'{}\n', b'{"version":1,"version":1}\n', b'{}\n{}\n', b'x' * (LIMIT + 1) + b'\n']:
                self.assertEqual(await self.wire(raw), b'{"ok":false}\n')
            value = json.loads(await self.wire(json.dumps({"version": 1, "operation": "login",
                                                          "value": self.ticket()}).encode() + b"\n"))
            self.assertTrue(value["ok"])
            server.config = replace(self.config, runtime_uid=os.getuid() + 1)
            self.assertIn(await self.wire(b'{}\n'), (b'{"ok":false}\n', b''))
        self.assertEqual(server.tasks, set())
        self.assertFalse(self.config.socket_path.exists())

    async def test_listener_disposal_closes_idle_connections(self):
        accepted = asyncio.Event()
        class ObservedServer(IdentityServer):
            def accept(self, reader, writer):
                super().accept(reader, writer)
                accepted.set()
        server = ObservedServer(self.authority)
        async with server.listening():
            reader, writer = await asyncio.open_unix_connection(str(self.config.socket_path))
            writer.write(b'{')
            await writer.drain()
            await asyncio.wait_for(accepted.wait(), 2)
        try:
            self.assertEqual(await asyncio.wait_for(reader.read(), 2), b'')
        finally:
            writer.close()
            await writer.wait_closed()
        self.assertEqual(server.tasks, set())

    def test_configuration_rejects_unknown_fields_and_privileged_runtime(self):
        base = {"version": 1, "socket_path": str(self.config.socket_path), "runtime_uid": os.getuid(),
                "issuer": "example.test", "secret_file": "unused", "identity_configs": [],
                "session_seconds": 60, "max_sessions": 4, "max_connections": 4, "timeout_seconds": 2}
        for raw in [{**base, "runtime_uid": 0}, {**base, "extra": True}, base]:
            with patch("shared_identity.private_bytes", return_value=json.dumps(raw).encode()), \
                 patch("shared_identity.trusted_directory"):
                with self.assertRaises(ValueError):
                    Configuration.load("/synthetic/config")


if __name__ == "__main__":
    unittest.main()
