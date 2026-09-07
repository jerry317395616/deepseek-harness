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
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from shared_identity import Configuration, IdentityServer, NativeRead, SharedIdentity, LIMIT, READ_LIMIT
from employee_gateway import b64encode


class IdentityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dsh-shared-identity-")
        self.addCleanup(self.temp.cleanup)
        self.now = 100
        self.enabled = {"teacher@example.test": True, "finance@example.test": True}
        self.config = Configuration(Path(self.temp.name) / "identity.sock", os.getuid(), "example.test",
                                    b"synthetic-shared-identity-key-00000", {user: None for user in self.enabled},
                                    60, 4, 4, 2, ("Student",))

        async def enabled(user):
            return self.enabled[user]
        self.authority = SharedIdentity(self.config, enabled, lambda: self.now)
        self.now = 101
        self.calls = []
        async def read(user, operation, arguments):
            self.calls.append((user, operation, arguments))
            return {"rows": [{"name": "synthetic-" + user.split("@")[0]}]}
        self.authority.read = read

    def ticket(self, user="teacher@example.test", **overrides):
        row = {"iss": "example.test", "sub": user, "iat": self.now, "exp": self.now + 60,
               "jti": secrets.token_urlsafe(16), **overrides}
        body = b64encode(json.dumps(row).encode())
        return body + "." + b64encode(hmac.digest(self.config.secret, body.encode(), "sha256"))

    async def call(self, operation, value, **extra):
        return await self.authority.execute({"version": 1, "operation": operation, "value": value, **extra})

    async def login(self, user="teacher@example.test"):
        return (await self.call("login", self.ticket(user)))["cookie"]

    async def read(self, cookie, **overrides):
        return await self.call("read", {"credential": cookie, "operation": "frappe_list_documents",
                                       "arguments": {"doctype": "Student"}, **overrides})

    async def test_reads_use_individual_accounts_with_one_runtime_uid(self):
        a, b = await asyncio.gather(self.login(), self.login("finance@example.test"))
        left, right = await asyncio.gather(self.read(a), self.read(b))
        self.assertEqual(left["rows"][0]["name"], "synthetic-teacher")
        self.assertEqual(right["rows"][0]["name"], "synthetic-finance")
        self.assertEqual({call[0] for call in self.calls}, set(self.enabled))
        for _user, _operation, arguments in self.calls:
            self.assertEqual(arguments, {"doctype": "Student", "fields": ["name"], "filters": {}, "limit": 20, "start": 0})

    async def test_read_denies_identity_overrides_writes_scope_and_sensitive_queries(self):
        cookie = await self.login()
        cases = [
            {"user": "finance@example.test"}, {"site": "other.test"},
            {"operation": "frappe_apply_document_update"}, {"operation": "frappe_platform_catalog"},
            {"arguments": {"doctype": "Student", "user": "Administrator"}},
            {"arguments": {"doctype": "Student", "ignore_permissions": True}},
            {"arguments": {"doctype": "Student", "fields": ["password"]}},
            {"arguments": {"doctype": "Student", "fields": ["count(*)"]}},
            {"arguments": {"doctype": "User"}}, {"arguments": {"doctype": "Sales Invoice"}},
            {"credential": "absent"}, {"arguments": []},
        ]
        for override in cases:
            with self.subTest(override=override), self.assertRaises(ValueError):
                await self.read(cookie, **override)
        self.assertEqual(self.calls, [])
        self.authority.read = None
        with self.assertRaises(ValueError):
            await self.read(cookie)

    async def test_logout_during_read_discards_result_and_new_login_does_not_revive_it(self):
        cookie = await self.login()
        entered, release = asyncio.Event(), asyncio.Event()
        async def waiting(*_arguments):
            entered.set()
            await release.wait()
            return {"private": "not released"}
        self.authority.read = waiting
        pending = asyncio.create_task(self.read(cookie))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            await self.call("logout", cookie)
            replacement = await self.login()
        finally:
            release.set()
        with self.assertRaises(ValueError):
            await pending
        self.assertEqual(self.authority.readers, set())
        self.assertIsNotNone(await self.authority.resolve(replacement))

    async def test_expiry_disable_and_permission_failure_do_not_release_read_results(self):
        for event in ("expiry", "disable", "failure"):
            cookie = await self.login()
            async def change_account(*_arguments):
                if event == "expiry":
                    self.now += 60
                elif event == "disable":
                    self.enabled["teacher@example.test"] = False
                else:
                    raise PermissionError("synthetic permission denied")
                return {"private": "not released"}
            self.authority.read = change_account
            with self.assertRaises((ValueError, PermissionError)):
                await self.read(cookie)
            self.assertEqual(self.authority.readers, set())
            self.enabled["teacher@example.test"] = True

    async def test_account_admission_is_bounded_and_cancellation_releases_it(self):
        a, b = await self.login(), await self.login("finance@example.test")
        entered = asyncio.Event()
        async def blocked(user, *_arguments):
            if user == "teacher@example.test":
                entered.set()
                await asyncio.Future()
            return {"rows": []}
        self.authority.read = blocked
        pending = asyncio.create_task(self.read(a))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            with self.assertRaises(ValueError):
                await self.read(a)
            self.assertEqual(await self.read(b), {"rows": []})
        finally:
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        self.assertEqual(self.authority.readers, set())

    async def test_native_adapter_selects_cookie_resolved_identity_not_runtime_uid(self):
        identities = {user: ("/synthetic/" + user, object()) for user in self.enabled}
        reader = NativeRead(replace(self.config, identities=identities))
        observed = []
        async def executor(binding, operation, arguments):
            observed.append((binding, operation, arguments))
            return {"ok": True, "result": {"rows": []}}
        reader.executor = executor
        for user in self.enabled:
            self.assertEqual(await reader(user, "frappe_list_documents", {"doctype": "Student"}), {"rows": []})
            binding, operation, arguments = observed[-1]
            self.assertEqual(binding.uid, self.config.runtime_uid)
            self.assertIs(binding.identity, identities[user][1])
            self.assertEqual(binding.identity_path, identities[user][0])
            self.assertEqual(binding.doctypes, ("Student",))
            self.assertEqual(operation, "frappe_list_documents")
            self.assertEqual(arguments, {"doctype": "Student"})

    async def test_wire_read_reply_is_bounded_and_exposes_no_private_error(self):
        cookie = await self.login()
        async def oversized(*_arguments):
            return {"value": "x" * READ_LIMIT}
        async with IdentityServer(self.authority).listening():
            payload = json.dumps({"version": 1, "operation": "read", "value": {
                "credential": cookie, "operation": "frappe_list_documents", "arguments": {"doctype": "Student"}}}).encode() + b"\n"
            result = json.loads(await self.wire(payload))
            self.assertTrue(result["ok"])
            self.authority.read = oversized
            self.assertEqual(await self.wire(payload), b'{"ok":false}\n')
            async def private_failure(*_arguments):
                raise RuntimeError("private backend detail")
            self.authority.read = private_failure
            self.assertEqual(await self.wire(payload), b'{"ok":false}\n')

    async def test_authority_shutdown_cancels_and_joins_an_accepted_read(self):
        cookie = await self.login()
        entered, finished = asyncio.Event(), asyncio.Event()
        async def blocked(*_arguments):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                finished.set()
        self.authority.read = blocked
        server = IdentityServer(self.authority)
        async with server.listening():
            payload = json.dumps({"version": 1, "operation": "read", "value": {
                "credential": cookie, "operation": "frappe_list_documents", "arguments": {"doctype": "Student"}}}).encode() + b"\n"
            pending = asyncio.create_task(self.wire(payload))
            await asyncio.wait_for(entered.wait(), 2)
        self.assertTrue(finished.is_set())
        self.assertEqual(await pending, b'')
        self.assertEqual(self.authority.readers, set())
        self.assertEqual(server.tasks, set())

    async def test_remote_deadline_releases_read_admission(self):
        cookie = await self.login()
        finished = asyncio.Event()
        async def blocked(*_arguments):
            try:
                await asyncio.Future()
            finally:
                finished.set()
        self.authority.read = blocked
        self.authority.config = replace(self.config, timeout_seconds=1)
        async with IdentityServer(self.authority).listening():
            payload = json.dumps({"version": 1, "operation": "read", "value": {
                "credential": cookie, "operation": "frappe_list_documents", "arguments": {"doctype": "Student"}}}).encode() + b"\n"
            self.assertEqual(await self.wire(payload), b'{"ok":false}\n')
            self.assertTrue(finished.is_set())
            self.assertEqual(self.authority.readers, set())

    def test_read_scope_is_explicit_and_protected_doctypes_cannot_be_configured(self):
        base = {"version": 1, "socket_path": str(self.config.socket_path), "runtime_uid": os.getuid() + 1,
                "issuer": "example.test", "secret_file": "unused", "identity_configs": ["/synthetic/account"],
                "session_seconds": 60, "max_sessions": 4, "max_connections": 4, "timeout_seconds": 2,
                "read_doctypes": ["Student"]}
        identity = SimpleNamespace(site="example.test", user="teacher@example.test", bench_root=Path(self.temp.name))
        for scope in (["Student"], [], ["User"], ["Student", "Student"], [None], [" Student"]):
            raw = {**base, "read_doctypes": scope}
            with patch("shared_identity.private_bytes", side_effect=[json.dumps(raw).encode(), self.config.secret]), \
                 patch("shared_identity.trusted_directory"), patch("shared_identity.pwd.getpwuid"), \
                 patch("shared_identity.IdentityConfiguration.load", return_value=identity):
                if scope in (["Student"], []):
                    self.assertEqual(Configuration.load("/synthetic/config").read_doctypes, tuple(scope))
                else:
                    with self.assertRaises(ValueError):
                        Configuration.load("/synthetic/config")

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
                "session_seconds": 60, "max_sessions": 4, "max_connections": 4, "timeout_seconds": 2, "read_doctypes": []}
        for raw in [{**base, "runtime_uid": 0}, {**base, "extra": True}, base]:
            with patch("shared_identity.private_bytes", return_value=json.dumps(raw).encode()), \
                 patch("shared_identity.trusted_directory"):
                with self.assertRaises(ValueError):
                    Configuration.load("/synthetic/config")

    def test_uid_policy_requires_explicit_consistent_nonroot_ownership(self):
        base = {"version": 1, "socket_path": str(self.config.socket_path), "runtime_uid": 1000,
                "issuer": "example.test", "secret_file": "unused", "identity_configs": ["/synthetic/account"],
                "session_seconds": 60, "max_sessions": 4, "max_connections": 4, "timeout_seconds": 2,
                "read_doctypes": ["Student"]}
        cases = [
            ({}, 1000, 1000, False),
            ({}, 1001, 1001, True),
            ({}, 1001, 1000, False),
            ({"uid_policy": "separate"}, 1001, 1001, True),
            ({"uid_policy": "single-user"}, 1000, 1000, True),
            ({"uid_policy": "single-user"}, 1001, 1000, False),
            ({"uid_policy": "single-user"}, 1000, 1001, False),
            ({"uid_policy": "single-user", "runtime_uid": 0}, 0, 0, False),
            ({"uid_policy": "automatic"}, 1000, 1000, False),
            ({"uid_policy": None}, 1000, 1000, False),
        ]
        for override, authority_uid, bench_uid, accepted in cases:
            identity = SimpleNamespace(site="example.test", user="teacher@example.test",
                                       bench_root=SimpleNamespace(stat=lambda: SimpleNamespace(st_uid=bench_uid)))
            with self.subTest(override=override, authority_uid=authority_uid, bench_uid=bench_uid), \
                 patch("shared_identity.private_bytes", side_effect=[json.dumps({**base, **override}).encode(), self.config.secret]), \
                 patch("shared_identity.trusted_directory"), patch("shared_identity.pwd.getpwuid"), \
                 patch("shared_identity.os.geteuid", return_value=authority_uid), \
                 patch("shared_identity.IdentityConfiguration.load", return_value=identity):
                if accepted:
                    config = Configuration.load("/synthetic/config")
                    self.assertEqual(config.uid_policy, override.get("uid_policy", "separate"))
                    self.assertEqual(config.read_doctypes, ("Student",))
                else:
                    with self.assertRaises(ValueError):
                        Configuration.load("/synthetic/config")


if __name__ == "__main__":
    unittest.main()
