"""Read-only deployment baseline for the Child employee Harness entry.

No authentication, Frappe import, secret file, service mutation or response-body
read. Findings are not deployment approval: routing, hostile-process isolation
and authenticated-browser evidence require separate acceptance.
"""
from __future__ import annotations

import argparse
import grp
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import (
    HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener,
)

BENCH = Path("/home/zyd/frappe/native-bench")
HARNESS = "https://harness.myyr.top/"
LOGIN = "https://child.myyr.top/login"
LAUNCHER = "/api/method/ione_core.harness_auth.launch"
PROPERTIES = (
    "LoadState", "ActiveState", "MainPID", "ProtectHome", "ProtectSystem",
    "PrivateTmp", "PrivateDevices", "NoNewPrivileges", "RestrictSUIDSGID",
    "MemoryMax", "TasksMax",
)
PENDING = (
    "public_proxy_routes_each_employee_to_a_distinct_restricted_runtime",
    "authenticated_browser_cookies_and_logout_disable_revocation",
    "runtime_cannot_read_bench_signing_material_or_peer_employee_homes",
    "runtime_cannot_bypass_proxy_or_invoke_privileged_database_helper",
    "assertion_renewal_failure_restart_and_resource_load_acceptance",
)


class NoRedirect(HTTPRedirectHandler):
    """Inspect the first HTTPS response; never follow a remote Location."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe_https(url):
    """Return only status and Location internally; never retain bodies/cookies."""
    opener = build_opener(
        ProxyHandler({}), HTTPSHandler(context=ssl.create_default_context()),
        NoRedirect(),
    )
    try:
        response = opener.open(Request(url, method="GET"), timeout=10)
    except HTTPError as response_error:
        response = response_error
    try:
        with response:
            return response.code, response.headers.get("Location", "")
    finally:
        response.close()


def is_login_redirect(status, location):
    try:
        parsed = urlsplit(location)
        return (
            status in (302, 303)
            and parsed.scheme == "https"
            and parsed.netloc == "child.myyr.top"
            and parsed.path == "/login"
            and not parsed.fragment
            and parse_qs(parsed.query, strict_parsing=True, max_num_fields=1)
            == {"redirect-to": [LAUNCHER]}
        )
    except (ValueError, TypeError):
        return False


def https_checks(probe=probe_https):
    result = {}
    for label, url in (("public_login_https", LOGIN), ("public_harness_redirect", HARNESS)):
        try:
            status, location = probe(url)
            result[label + "_tls_verified"] = True
            result[label + "_response_expected"] = (
                status == 200 if label == "public_login_https"
                else is_login_redirect(status, location)
            )
        except (OSError, URLError, ValueError):
            result[label + "_tls_verified"] = False
            result[label + "_response_expected"] = False
    return result


def safe_environment():
    """Keep only the local systemd connection, locale and executable search."""
    return {key: value for key, value in os.environ.items()
            if key in {"PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
                       "LANG", "LC_ALL"}}


def service_properties(unit, scope, run=subprocess.run):
    """Request only enumerated non-secret properties; reject ambiguous output."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service", unit):
        raise ValueError("invalid unit")
    if scope not in ("user", "system"):
        raise ValueError("invalid scope")
    command = ["systemctl"]
    if scope == "user":
        command.append("--user")
    command.extend(["show", "--no-pager", "--property=" + ",".join(PROPERTIES), unit])
    result = run(command, capture_output=True, text=True, timeout=10, check=True,
                 env=safe_environment())
    values = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if not separator or key not in PROPERTIES or key in values:
            raise ValueError("unexpected service property")
        values[key] = value
    if set(values) != set(PROPERTIES):
        raise ValueError("missing service property")
    return values


def read_identity(pid):
    """Read numeric identity and hardening flags, never argv or environment."""
    if not isinstance(pid, int) or pid <= 0:
        raise ValueError("invalid pid")
    wanted = {"Uid", "Gid", "Groups", "NoNewPrivs", "CapEff"}
    values = {}
    with Path(f"/proc/{pid}/status").open(encoding="ascii") as source:
        for line in source:
            key, separator, value = line.partition(":")
            if separator and key in wanted:
                if key in values:
                    raise ValueError("duplicate process field")
                values[key] = value.split()
    if set(values) != wanted:
        raise ValueError("missing process field")
    if any(len(values[key]) != 4 for key in ("Uid", "Gid")):
        raise ValueError("invalid process identity")
    if len(values["NoNewPrivs"]) != 1 or len(values["CapEff"]) != 1:
        raise ValueError("invalid process security flags")
    return {
        "uids": [int(value) for value in values["Uid"]],
        "gids": [int(value) for value in values["Gid"]],
        "groups": [int(value) for value in values["Groups"]],
        "no_new_privileges": values["NoNewPrivs"] == ["1"],
        "capabilities": int(values["CapEff"][0], 16),
    }


def finite_positive(value):
    return isinstance(value, str) and value.isascii() and value.isdecimal() and 0 < int(value) < 2**63


def runtime_checks(props, identity, bench_uid, bench_gid, forbidden_groups):
    """A hardened candidate remains subject to the separate acceptance checks."""
    ids = identity or {}
    uids = ids.get("uids", [])
    gids = ids.get("gids", [])
    groups = ids.get("groups", [])
    return {
        "runtime_active": props.get("LoadState") == "loaded" and props.get("ActiveState") == "active"
                          and finite_positive(props.get("MainPID")),
        "runtime_distinct_unprivileged_uid": len(uids) == 4 and all(
            uid > 0 and uid != bench_uid for uid in uids),
        "runtime_no_privileged_groups": len(gids) == 4 and all(
            gid > 0 and gid != bench_gid and gid not in forbidden_groups
            for gid in gids + groups),
        "runtime_no_effective_capabilities": ids.get("capabilities") == 0,
        "runtime_no_new_privileges": props.get("NoNewPrivileges") == "yes"
                                     and ids.get("no_new_privileges") is True,
        "runtime_protect_home": props.get("ProtectHome") in ("yes", "tmpfs"),
        "runtime_readonly_system": props.get("ProtectSystem") == "strict",
        "runtime_private_tmp": props.get("PrivateTmp") in ("yes", "disconnected"),
        "runtime_private_devices": props.get("PrivateDevices") == "yes",
        "runtime_restrict_suid": props.get("RestrictSUIDSGID") == "yes",
        "runtime_memory_bound": finite_positive(props.get("MemoryMax")),
        "runtime_task_bound": finite_positive(props.get("TasksMax")),
    }


def collect_runtime(unit, scope):
    try:
        info = BENCH.stat()
        forbidden = {0}
        for name in ("sudo", "wheel", "docker", "lxd", "disk", "shadow", "adm"):
            try:
                forbidden.add(grp.getgrnam(name).gr_gid)
            except KeyError:
                pass  # A group absent from this host grants no local membership.
        before = service_properties(unit, scope)
        identity = read_identity(int(before["MainPID"]))
        after = service_properties(unit, scope)
        if before != after:
            raise ValueError("service changed during inspection")
        return runtime_checks(after, identity, info.st_uid, info.st_gid, forbidden)
    except (OSError, ValueError, subprocess.SubprocessError):
        return runtime_checks({}, None, -1, -1, set())


def report(checks):
    """Emit authored check ids/booleans only, even when observations contain secrets."""
    return {
        "kind": "employee_deployment_preflight",
        "version": 1,
        "automated_baseline_passed": bool(checks) and all(checks.values()),
        "deployment_approved": False,
        "checks": checks,
        "requires_separate_acceptance": list(PENDING),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit", default="ione-harness.service")
    parser.add_argument("--scope", choices=("user", "system"), default="user")
    args = parser.parse_args()
    checks = https_checks()
    checks.update(collect_runtime(args.unit, args.scope))
    print(json.dumps(report(checks), indent=2))
    # This inventory cannot certify the remaining browser and isolation checks.
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
