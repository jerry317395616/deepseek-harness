"""Linux peer-credential and readonly broker tests with disposable local fixtures."""
import asyncio
import json
import os
from pathlib import Path
import pwd
import signal
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import employee_read_broker as broker
from native_actor_refresh import Configuration as IdentityConfiguration


class Fixture:
    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dsh-broker-", dir=Path.home())
        self.root = Path(self.temporary.name)
        self.site = "child.example.test"
        self.bench = self.root / "bench"
        (self.bench / "sites" / self.site).mkdir(parents=True)
        self.private = self.root / "private"
        self.private.mkdir(mode=0o700)
        self.identity_file = self.private / "identity.json"
        self.identity_raw = {
            "version": 1, "bench_root": str(self.bench), "site": self.site,
            "user": "teacher@example.test", "assertion_file": str(self.private / "actor.assertion"),
            "ttl_seconds": 60,
        }
        self.save(self.identity_file, self.identity_raw)
        self.path = self.root / "broker.sock"
        self.raw = {
            "version": 1, "socket_path": str(self.path),
            "bindings": [{"uid": pwd.getpwnam("nobody").pw_uid,
                          "identity_config": str(self.identity_file), "business_doctypes": ["Student"]}],
            "request_seconds": 1, "operation_seconds": 1, "max_connections": 4,
            "max_input_bytes": 16384, "max_output_bytes": 16384,
        }
        self.config_path = self.private / "broker.json"
        self.save(self.config_path, self.raw)

    def save(self, path, value):
        path.write_text(json.dumps(value), encoding="utf-8")
        path.chmod(0o600)

    def load(self):
        self.save(self.config_path, self.raw)
        return broker.Configuration.load(str(self.config_path))

    def in_process_config(self):
        # Only the protocol fixture binds the test runner's UID. Production load
        # rejects sharing a UID with the trusted broker/Bench, tested separately.
        identity = IdentityConfiguration.load(str(self.identity_file))
        binding = broker.Binding(os.geteuid(), str(self.identity_file), identity, ("Student",))
        return broker.Configuration(self.path, {binding.uid: binding}, 1, 1, 4, 16384, 16384)

    def close(self):
        self.temporary.cleanup()


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)

    def test_private_config_loads_only_a_distinct_existing_uid(self):
        config = self.fixture.load()
        self.assertNotIn(os.geteuid(), config.bindings)
        self.assertEqual(config.bindings[pwd.getpwnam("nobody").pw_uid].identity.user, "teacher@example.test")

    def test_same_uid_root_duplicate_uid_and_duplicate_employee_rejected(self):
        for mode in ("same", "root", "duplicate", "duplicate_employee"):
            with self.subTest(mode=mode):
                fixture = Fixture()
                try:
                    if mode == "same":
                        fixture.raw["bindings"][0]["uid"] = os.geteuid()
                    elif mode == "root":
                        fixture.raw["bindings"][0]["uid"] = 0
                    elif mode == "duplicate":
                        fixture.raw["bindings"] *= 2
                    else:
                        fixture.raw["bindings"].append({
                            **fixture.raw["bindings"][0], "uid": pwd.getpwnam("daemon").pw_uid,
                        })
                    with self.assertRaises(ValueError):
                        fixture.load()
                finally:
                    fixture.close()

    def test_public_or_link_config_rejected(self):
        path = self.fixture.config_path
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            broker.Configuration.load(str(path))
        path.chmod(0o600)
        link = path.with_name("link.json")
        link.symlink_to(path)
        with self.assertRaises(OSError):
            broker.Configuration.load(str(link))

    def test_writable_socket_parent_and_protected_scope_rejected(self):
        self.fixture.root.chmod(0o777)
        with self.assertRaises(ValueError):
            self.fixture.load()
        self.fixture.root.chmod(0o700)
        self.fixture.raw["bindings"][0]["business_doctypes"] = ["User"]
        with self.assertRaises(ValueError):
            self.fixture.load()

    def test_unknown_config_fields_and_invalid_limits_rejected(self):
        self.fixture.raw["shell"] = "not permitted"
        with self.assertRaises(ValueError):
            self.fixture.load()
        del self.fixture.raw["shell"]
        for field in ("max_connections", "request_seconds", "operation_seconds", "max_input_bytes", "max_output_bytes"):
            prior = self.fixture.raw[field]
            self.fixture.raw[field] = 0
            with self.assertRaises(ValueError):
                self.fixture.load()
            self.fixture.raw[field] = prior


class BrokerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)
        self.config = self.fixture.in_process_config()
        self.calls = []

    async def execute(self, binding, operation, arguments):
        self.calls.append((binding.uid, operation, arguments))
        return {"ok": True, "result": {"documents": [{"name": "fixture-student"}]}}

    def request(self, **changes):
        return {"version": 1, "operation": "frappe_list_documents",
                "arguments": {"doctype": "Student"}, **changes}

    async def exchange(self, value, *, raw=False):
        reader, writer = await asyncio.open_unix_connection(str(self.fixture.path))
        try:
            writer.write(value if raw else json.dumps(value).encode() + b"\n")
            await writer.drain()
            writer.write_eof()
            async with asyncio.timeout(5):
                data = await reader.read()
            return data
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_real_peer_uid_selects_pinned_binding(self):
        service = broker.EmployeeBroker(self.config, self.execute)
        async with service.listening():
            data = json.loads(await self.exchange(self.request()))
            self.assertTrue(data["ok"])
            self.assertEqual(self.calls[0][0], os.geteuid())
            self.assertEqual(self.calls[0][2]["fields"], ["name"])
        self.assertFalse(self.fixture.path.exists())
        self.assertFalse(service.tasks)

    async def test_unbound_real_peer_never_reaches_executor(self):
        config = self.fixture.load()
        async with broker.EmployeeBroker(config, self.execute).listening():
            self.assertEqual(await self.exchange(self.request()), broker.DENIED)
        self.assertEqual(self.calls, [])

    async def test_forged_identity_writes_and_out_of_scope_requests_rejected(self):
        invalid = [
            self.request(user="Administrator"), self.request(uid=0),
            self.request(operation="frappe_apply_document_update"),
            self.request(arguments={"doctype": "Sales Invoice"}),
            self.request(arguments={"doctype": "User"}),
            self.request(version=True), self.request(operation="shell"),
        ]
        async with broker.EmployeeBroker(self.config, self.execute).listening():
            for value in invalid:
                self.assertEqual(await self.exchange(value), broker.DENIED)
        self.assertEqual(self.calls, [])

    async def test_duplicate_json_nonfinite_extra_frame_and_oversized_input_rejected(self):
        invalid = [
            b'{"version":1,"version":1,"operation":"frappe_list_documents","arguments":{"doctype":"Student"}}\n',
            b'{"version":1,"operation":"frappe_list_documents","arguments":{"doctype":"Student","limit":NaN}}\n',
            json.dumps(self.request()).encode() + b"\n{}",
            b"x" * (self.config.max_input_bytes + 2) + b"\n",
        ]
        async with broker.EmployeeBroker(self.config, self.execute).listening():
            for value in invalid:
                self.assertEqual(await self.exchange(value, raw=True), broker.DENIED)
        self.assertEqual(self.calls, [])

    async def test_same_uid_concurrent_request_is_rejected(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def blocked(*args):
            started.set()
            await release.wait()
            return await self.execute(*args)
        async with broker.EmployeeBroker(self.config, blocked).listening():
            first = asyncio.create_task(self.exchange(self.request()))
            try:
                await asyncio.wait_for(started.wait(), 5)
                self.assertEqual(await self.exchange(self.request()), broker.DENIED)
            finally:
                release.set()
                await first
        self.assertEqual(len(self.calls), 1)

    async def test_executor_failure_and_large_response_are_fixed_denials(self):
        async def failed(*_args):
            raise RuntimeError("DO_NOT_DISCLOSE")
        async def oversized(*_args):
            return {"ok": True, "result": "x" * self.config.max_output_bytes}
        for execute in (failed, oversized):
            async with broker.EmployeeBroker(self.config, execute).listening():
                self.assertEqual(await self.exchange(self.request()), broker.DENIED)

    async def test_shutdown_cancels_and_awaits_owned_work(self):
        started, completed = asyncio.Event(), asyncio.Event()
        async def blocked(*_args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                completed.set()
        service = broker.EmployeeBroker(self.config, blocked)
        async with service.listening():
            first = asyncio.create_task(self.exchange(self.request()))
            await asyncio.wait_for(started.wait(), 5)
        await first
        self.assertTrue(completed.is_set())
        self.assertFalse(service.tasks)
        self.assertFalse(self.fixture.path.exists())

    async def test_existing_socket_path_is_never_overwritten(self):
        self.fixture.path.write_text("keep", encoding="ascii")
        with self.assertRaises(OSError):
            async with broker.EmployeeBroker(self.config, self.execute).listening():
                self.fail("occupied socket accepted")
        self.assertEqual(self.fixture.path.read_text(), "keep")

    async def test_stalled_input_expires_without_query(self):
        async with broker.EmployeeBroker(self.config, self.execute).listening():
            reader, writer = await asyncio.open_unix_connection(str(self.fixture.path))
            try:
                writer.write(b"{")
                await writer.drain()
                async with asyncio.timeout(5):
                    self.assertEqual(await reader.read(), broker.DENIED)
            finally:
                writer.close()
                await writer.wait_closed()
        self.assertEqual(self.calls, [])


class ExecutorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)
        self.config = self.fixture.in_process_config()

    async def test_fixed_query_identity_and_post_read_check(self):
        commands = []
        async def process(argv, payload, **kwargs):
            commands.append((argv, payload, kwargs))
            return b'{"ok":true,"result":{"documents":[]}}' if len(commands) == 1 else b"employee identity verified"
        binding = self.config.bindings[os.geteuid()]
        with patch.object(broker, "bounded_process", process):
            result = await broker.NativeExecutor(self.config)(binding, "frappe_list_documents", {"doctype": "Student"})
        self.assertEqual(result, {"ok": True, "result": {"documents": []}})
        self.assertIn("--access-mode", commands[0][0])
        self.assertIn("business", commands[0][0])
        self.assertIn(binding.identity.user, commands[0][0])
        self.assertEqual(commands[1][0][-3:], ["--config", binding.identity_path, "--check"])
        self.assertNotIn("assertion", commands[0][1].decode())

    async def test_disabled_account_after_read_rejects_result(self):
        calls = 0
        async def process(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return b'{"ok":true,"result":{"private":"NOT_RELEASED"}}'
            raise ValueError("disabled")
        with patch.object(broker, "bounded_process", process):
            with self.assertRaises(ValueError):
                await broker.NativeExecutor(self.config)(
                    self.config.bindings[os.geteuid()], "frappe_list_documents", {"doctype": "Student"})

    async def test_identity_configuration_change_rejected_before_worker(self):
        self.fixture.identity_raw["user"] = "other@example.test"
        self.fixture.save(self.fixture.identity_file, self.fixture.identity_raw)
        async def forbidden(*_args, **_kwargs):
            self.fail("rebound identity reached worker")
        with patch.object(broker, "bounded_process", forbidden):
            with self.assertRaises(ValueError):
                await broker.NativeExecutor(self.config)(
                    self.config.bindings[os.geteuid()], "frappe_list_documents", {"doctype": "Student"})

    async def test_worker_environment_stderr_and_output_limit(self):
        with patch.dict(os.environ, {"BROKER_TEST_SECRET": "synthetic-test-value"}):
            data = await broker.bounded_process(
                [sys.executable, "-c", "import os,sys; sys.stderr.write('DO_NOT_DISCLOSE'); print(os.getenv('BROKER_TEST_SECRET','absent'))"],
                b"", cwd=self.fixture.root, timeout=5, output_limit=128,
            )
        self.assertEqual(data.strip(), b"absent")
        with self.assertRaises(ValueError):
            await broker.bounded_process(
                [sys.executable, "-c", "print('x'*10000)"], b"", cwd=self.fixture.root,
                timeout=5, output_limit=128,
            )

    async def test_worker_reads_all_chunks_within_byte_limit(self):
        data = await broker.bounded_process(
            [sys.executable, "-c", "import sys; sys.stdout.write('x'*131072)"],
            b"", cwd=self.fixture.root, timeout=5, output_limit=131072,
        )
        self.assertEqual(data, b"x" * 131072)

    async def test_worker_deadline_reaps_the_process(self):
        original, handles = asyncio.create_subprocess_exec, []
        async def capture(*args, **kwargs):
            child = await original(*args, **kwargs)
            handles.append(child)
            return child
        with patch.object(broker.asyncio, "create_subprocess_exec", capture):
            with self.assertRaises(TimeoutError):
                await broker.bounded_process(
                    [sys.executable, "-c", "import time; time.sleep(30)"], b"",
                    cwd=self.fixture.root, timeout=0.05, output_limit=128,
                )
        self.assertEqual(handles[0].returncode, -signal.SIGKILL)

    async def test_cli_checks_configuration_without_listening(self):
        self.fixture.load()
        argv = [sys.executable, "-B", str(broker.HELPERS / "employee_read_broker.py"),
                "--config", str(self.fixture.config_path), "--check"]
        result = await asyncio.to_thread(subprocess.run, argv, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"employee read broker configuration verified\n")
        self.assertFalse(self.fixture.path.exists())
        self.fixture.raw["version"] = 2
        self.fixture.save(self.fixture.config_path, self.fixture.raw)
        result = await asyncio.to_thread(subprocess.run, argv, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"employee read broker failed\n")
        self.assertEqual(result.stdout, b"")

    async def test_cancelled_worker_is_reaped(self):
        original = asyncio.create_subprocess_exec
        spawned, handles = asyncio.Event(), []
        async def capture(*args, **kwargs):
            child = await original(*args, **kwargs)
            handles.append(child)
            spawned.set()
            return child
        with patch.object(broker.asyncio, "create_subprocess_exec", capture):
            task = asyncio.create_task(broker.bounded_process(
                [sys.executable, "-c", "import time; time.sleep(30)"], b"",
                cwd=self.fixture.root, timeout=5, output_limit=128,
            ))
            await asyncio.wait_for(spawned.wait(), 5)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(handles[0].returncode, -signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
