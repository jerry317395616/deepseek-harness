"""Linux-only, deployment-owned readonly Frappe broker over a Unix socket.

SO_PEERCRED selects a pinned employee; requests carry no identity or credentials.
The trusted worker retains Bench access. This auxiliary backend does not change
Harness profiles, create OS accounts or expose a network listener.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import pwd
import signal
import socket
import stat
import struct
import sys

from employee_gateway import integer, private_bytes
from native_actor_refresh import Configuration as IdentityConfiguration
from native_frappe_query import normalize_arguments

OPERATIONS = frozenset({
    "frappe_describe_doctype", "frappe_list_documents", "frappe_get_document",
})
HELPERS = Path(__file__).resolve().parent
DENIED = b'{"ok":false,"error":"employee broker request denied"}\n'


def strict_json(raw):
    """Reject non-finite constants and duplicate keys at the process boundary."""
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError("invalid JSON constant")

    return json.loads(raw, object_pairs_hook=object_pairs, parse_constant=invalid_constant)


def trusted_directory(path):
    """All socket-path parents are canonical and unwritable by employee users."""
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("socket directory must be canonical")
    for parent in (path, *path.parents):
        info = parent.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, os.geteuid()}
                or info.st_mode & 0o022):
            raise ValueError("socket directory must be deployment-owned")


@dataclass(frozen=True)
class Binding:
    uid: int
    identity_path: str
    identity: IdentityConfiguration
    doctypes: tuple[str, ...]


@dataclass(frozen=True)
class Configuration:
    socket_path: Path
    bindings: dict[int, Binding]
    request_seconds: int
    operation_seconds: int
    max_connections: int
    max_input_bytes: int
    max_output_bytes: int

    @classmethod
    def load(cls, path):
        if sys.platform != "linux" or not hasattr(socket, "SO_PEERCRED"):
            raise ValueError("broker requires Linux peer credentials")
        raw = strict_json(private_bytes(path, 65536))
        fields = {"version", "socket_path", "bindings", "request_seconds",
                  "operation_seconds", "max_connections", "max_input_bytes", "max_output_bytes"}
        if not isinstance(raw, dict) or set(raw) != fields or type(raw["version"]) is not int or raw["version"] != 1:
            raise ValueError("invalid broker configuration")
        target = Path(raw["socket_path"])
        if not target.is_absolute() or len(os.fsencode(target)) > 107 or target.name in {".", ".."}:
            raise ValueError("invalid socket path")
        trusted_directory(target.parent)
        rows = raw["bindings"]
        if not isinstance(rows, list) or not 1 <= len(rows) <= 64:
            raise ValueError("explicit bindings required")
        bindings, employees = {}, set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"uid", "identity_config", "business_doctypes"}:
                raise ValueError("invalid binding")
            uid = integer(row["uid"], 1, 2**31 - 1)
            pwd.getpwuid(uid)
            identity = IdentityConfiguration.load(row["identity_config"])
            if uid in {os.geteuid(), identity.bench_root.stat().st_uid} or uid in bindings:
                raise ValueError("employee UID must differ from broker and Bench owner")
            key = (identity.site, identity.user)
            if key in employees:
                raise ValueError("employee may only have one UID")
            scope = row["business_doctypes"]
            if not isinstance(scope, list) or not 1 <= len(scope) <= 64 or len(set(scope)) != len(scope):
                raise ValueError("invalid business scope")
            for name in scope:
                if not isinstance(name, str) or normalize_arguments("frappe_describe_doctype", {"doctype": name})["doctype"] != name:
                    raise ValueError("invalid business scope")
            bindings[uid] = Binding(uid, row["identity_config"], identity, tuple(scope))
            employees.add(key)
        return cls(target, bindings, integer(raw["request_seconds"], 1, 30),
                   integer(raw["operation_seconds"], 1, 120), integer(raw["max_connections"], 1, 64),
                   integer(raw["max_input_bytes"], 16384, 1000000),
                   integer(raw["max_output_bytes"], 16384, 5000000))


def prepare_request(raw, binding):
    request = strict_json(raw)
    if (not isinstance(request, dict) or set(request) != {"version", "operation", "arguments"}
            or type(request["version"]) is not int or request["version"] != 1
            or not isinstance(request["operation"], str) or request["operation"] not in OPERATIONS
            or not isinstance(request["arguments"], dict)):
        raise ValueError("invalid read request")
    operation = request["operation"]
    arguments = normalize_arguments(operation, request["arguments"])
    if arguments["doctype"] not in binding.doctypes:
        raise ValueError("DocType not in employee scope")
    return operation, arguments


async def bounded_process(argv, payload, *, cwd, timeout, output_limit):
    """Bound worker bytes/time; discard stderr and reap a cancelled live worker."""
    process = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONNOUSERSITE": "1"},
    )
    try:
        async with asyncio.timeout(timeout):
            process.stdin.write(payload)
            await process.stdin.drain()
            process.stdin.close()
            result = bytearray()
            while chunk := await process.stdout.read(min(65536, output_limit + 1 - len(result))):
                result.extend(chunk)
                if len(result) > output_limit:
                    raise ValueError("worker output exceeds limit")
            code = await process.wait()
            if code != 0:
                raise ValueError("worker rejected request")
            return bytes(result)
    finally:
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # The owned worker exited before cancellation reached it.
            await process.wait()


class NativeExecutor:
    """Only this trusted process invokes the fixed Bench query and identity checker."""

    def __init__(self, config):
        self.config = config

    async def __call__(self, binding, operation, arguments):
        identity = binding.identity
        python = str(identity.bench_root / "env/bin/python")
        # Configuration replacement must not silently rebind the post-read check.
        if IdentityConfiguration.load(binding.identity_path) != identity:
            raise ValueError("identity configuration changed")
        argv = [
            python, "-s", "-B", str(HELPERS / "native_frappe_query.py"),
            "--bench-root", str(identity.bench_root), "--site", identity.site,
            "--user", identity.user, "--operation", operation,
            "--access-mode", "business", "--actor-token-file", str(identity.assertion_file),
            "--business-doctypes", json.dumps(binding.doctypes),
            "--max-input-bytes", str(self.config.max_input_bytes),
            "--max-output-bytes", str(self.config.max_output_bytes),
        ]
        payload = json.dumps({"arguments": arguments}, ensure_ascii=False).encode()
        if len(payload) > self.config.max_input_bytes:
            raise ValueError("normalized request exceeds input limit")
        result = await bounded_process(argv, payload, cwd=identity.bench_root,
                                       timeout=self.config.operation_seconds,
                                       output_limit=self.config.max_output_bytes)
        parsed = strict_json(result)
        if not isinstance(parsed, dict) or parsed.get("ok") is not True or "result" not in parsed:
            raise ValueError("worker rejected read")
        await bounded_process(
            [python, "-s", "-B", str(HELPERS / "native_actor_refresh.py"),
             "--config", binding.identity_path, "--check"], b"", cwd=identity.bench_root,
            timeout=self.config.operation_seconds, output_limit=4096,
        )
        if IdentityConfiguration.load(binding.identity_path) != identity:
            raise ValueError("identity configuration changed")
        return {"ok": True, "result": parsed["result"]}


class EmployeeBroker:
    """Own each connection and worker; at most one in-flight request per UID."""

    def __init__(self, config, execute):
        self.config = config
        self.execute = execute
        self.tasks = set()
        self.active_uids = set()
        self.closing = False

    def accept(self, reader, writer):
        if self.closing or len(self.tasks) >= self.config.max_connections:
            writer.transport.abort()
            return
        task = asyncio.create_task(self.handle(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def handle(self, reader, writer):
        uid = None
        admitted = False
        try:
            peer = writer.get_extra_info("socket").getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            _pid, uid, _gid = struct.unpack("3i", peer)
            binding = self.config.bindings.get(uid)
            admitted = (not self.closing and binding is not None
                        and uid not in self.active_uids
                        and len(self.active_uids) < self.config.max_connections)
            if admitted:
                self.active_uids.add(uid)
            async with asyncio.timeout(self.config.request_seconds):
                raw = await reader.readuntil(b"\n")
                if len(raw) > self.config.max_input_bytes or await reader.read(1):
                    raise ValueError("one bounded request per connection required")
            if not admitted:
                raise ValueError("peer not admitted")
            operation, arguments = prepare_request(raw, binding)
            result = await self.execute(binding, operation, arguments)
            output = json.dumps(result, ensure_ascii=False, allow_nan=False).encode() + b"\n"
            if len(output) > self.config.max_output_bytes:
                raise ValueError("response exceeds output limit")
            writer.write(output)
            async with asyncio.timeout(self.config.request_seconds):
                await writer.drain()
        except Exception:
            # The wire never carries worker, parser or deployment diagnostics.
            try:
                writer.write(DENIED)
                async with asyncio.timeout(self.config.request_seconds):
                    await writer.drain()
            except (OSError, TimeoutError, RuntimeError):
                pass  # A disconnected or stalled client receives no diagnostic.
        finally:
            if admitted:
                self.active_uids.discard(uid)
            writer.close()
            try:
                async with asyncio.timeout(self.config.request_seconds):
                    await writer.wait_closed()
            except TimeoutError:
                writer.transport.abort()
            except OSError:
                pass  # Peer reset while closing this owned connection.

    @asynccontextmanager
    async def listening(self):
        """Refuse occupied paths; remove only this listener's own socket inode."""
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        owned = None
        server = None
        try:
            listener.bind(str(self.config.socket_path))
            owned = self.config.socket_path.lstat()
            os.chmod(self.config.socket_path, 0o666)
            listener.setblocking(False)
            server = await asyncio.start_unix_server(
                self.accept, sock=listener, limit=self.config.max_input_bytes + 1,
                cleanup_socket=False,
            )
            yield self
        finally:
            self.closing = True
            if server is not None:
                server.close()
            listener.close()
            pending = tuple(self.tasks)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            if server is not None:
                await server.wait_closed()
            if owned is not None:
                try:
                    current = self.config.socket_path.lstat()
                    if (stat.S_ISSOCK(current.st_mode)
                            and (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino)):
                        self.config.socket_path.unlink()
                except FileNotFoundError:
                    pass  # The owned socket was already removed externally.


async def serve(config):
    broker = EmployeeBroker(config, NativeExecutor(config))
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    try:
        async with broker.listening():
            print("employee read broker ready", flush=True)
            await stopped.wait()
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--check", action="store_true", help="Validate deployment files without listening")
    args = parser.parse_args()
    try:
        config = Configuration.load(args.config)
        if args.check:
            print("employee read broker configuration verified")
        else:
            asyncio.run(serve(config))
    except Exception:
        print("employee read broker failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
