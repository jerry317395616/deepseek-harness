"""Refresh one pinned employee assertion using the active Native Bench.

This trusted deployment process is not a model tool or a login endpoint.
It never prints assertions or signing material and never commits business data.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time

from employee_gateway import integer, private_bytes


@dataclass(frozen=True)
class Configuration:
    bench_root: Path
    site: str
    user: str
    assertion_file: Path
    ttl_seconds: int

    @classmethod
    def load(cls, path: str) -> Configuration:
        raw = json.loads(private_bytes(path, 16384))
        if (not isinstance(raw, dict) or set(raw) != {
                "version", "bench_root", "site", "user", "assertion_file", "ttl_seconds",
        } or type(raw["version"]) is not int or raw["version"] != 1):
            raise ValueError("invalid refresh configuration")
        user = raw["user"]
        if (not isinstance(user, str) or not 1 <= len(user) <= 254 or user != user.strip()
                or any(ord(char) < 32 or ord(char) == 127 for char in user)
                or user.casefold() in {"guest", "administrator"}):
            raise ValueError("an explicit employee account is required")
        site = raw["site"]
        if not isinstance(site, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,127}", site):
            raise ValueError("invalid site")
        root = Path(raw["bench_root"])
        output = Path(raw["assertion_file"])
        if (not root.is_absolute() or root.resolve(strict=True) != root
                or not (root / "sites" / site).is_dir()
                or not (root / "sites" / site).resolve().is_relative_to(root / "sites")):
            raise ValueError("active Native Bench site is unavailable")
        if (not output.is_absolute() or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", output.name)
                or output.parent.resolve(strict=True) != output.parent
                or Path(path).resolve() == output):
            raise ValueError("invalid assertion destination")
        return cls(root, site, user, output, integer(raw["ttl_seconds"], 60, 900))


class AssertionDestination:
    """Own a private directory descriptor; publish complete files by atomic rename."""

    def __init__(self, path: Path):
        self.name = path.name
        self.fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(self.fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise ValueError("assertion directory must be owner-only")
            self.check_existing()
        except BaseException:
            os.close(self.fd)
            raise

    def close(self) -> None:
        os.close(self.fd)

    def check_existing(self) -> None:
        try:
            info = os.stat(self.name, dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            raise ValueError("existing assertion must be a private regular file")

    def revoke(self) -> None:
        """Remove only a validated destination, without following links."""
        self.check_existing()
        try:
            os.unlink(self.name, dir_fd=self.fd)
        except FileNotFoundError:
            return
        os.fsync(self.fd)

    def publish(self, assertion: str) -> None:
        data = assertion.encode("ascii")
        if not data or len(data) > 4096:
            raise ValueError("invalid assertion")
        temporary = ".refresh-" + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self.check_existing()
            os.replace(temporary, self.name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError:
                pass  # Successful publication consumed the temporary name.


def issue_assertion(frappe, config: Configuration) -> str:
    """Bind the deployed I-ONE verifier to an exact enabled System User."""
    account = frappe.db.get_value("User", config.user,
                                 ["name", "email", "enabled", "user_type"], as_dict=True)
    if (not account or account.name != config.user or not account.enabled
            or account.user_type != "System User" or not isinstance(account.email, str)
            or not 1 <= len(account.email.strip()) <= 254):
        raise ValueError("employee is unavailable")
    key = str(frappe.conf.get("ione_agent_identity_shared_secret") or "").strip()
    if len(key) < 32:
        raise ValueError("identity signing is unavailable")
    now = int(time.time())
    payload = {"v": 1, "iss": "ione-agent", "iat": now, "exp": now + config.ttl_seconds,
               "aud": config.site, "email": account.email.strip(), "user": config.user}

    def encode(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")

    body = "ione1." + encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    assertion = body + "." + encode(hmac.new(key.encode("utf-8"), body.encode("ascii"),
                                           hashlib.sha256).digest())
    from ione_core.mcp.identity import resolve_actor_user
    if resolve_actor_user(assertion) != config.user:
        raise ValueError("identity verifier rejected the pinned employee")
    return assertion


def with_native_bench(config: Configuration) -> str:
    """Read current account state and verify the assertion without a database commit."""
    previous = Path.cwd()
    frappe = None
    try:
        os.chdir(config.bench_root)
        import frappe
        frappe.init(site=config.site, sites_path=str(config.bench_root / "sites"))
        frappe.connect(set_admin_as_user=False)
        return issue_assertion(frappe, config)
    finally:
        try:
            if frappe is not None:
                try:
                    if getattr(frappe.local, "db", None) is not None:
                        frappe.db.rollback()
                finally:
                    frappe.destroy()
        finally:
            os.chdir(previous)


def refresh(config: Configuration, *, check: bool = False) -> None:
    """Revoke an old assertion on refresh failure; check mode never writes."""
    destination = AssertionDestination(config.assertion_file)
    try:
        try:
            assertion = with_native_bench(config)
            if not check:
                destination.publish(assertion)
        except Exception:
            if not check:
                destination.revoke()
            raise
    finally:
        destination.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Refresh a pinned Native Bench employee identity")
    parser.add_argument("--config", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    # Frappe startup and verifier errors may include deployment configuration.
    # The service emits only these fixed outcomes, never third-party diagnostics.
    with open(os.devnull, "w") as sink, redirect_stdout(sink), redirect_stderr(sink):
        try:
            config = Configuration.load(args.config)
            refresh(config, check=args.check)
        except Exception:
            succeeded = False
        else:
            succeeded = True
    if not succeeded:
        print("employee assertion refresh failed", file=sys.stderr)
        return 1
    print("employee identity verified" if args.check else "employee assertion refreshed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
