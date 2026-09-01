"""Bounded local read-only bridge into the active Native Bench Frappe site.

The TypeScript plugin is the policy boundary. This helper deliberately keeps a
second operation allowlist so a compromised or stale caller cannot turn the
Frappe process into an arbitrary Python or SQL executor.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from importlib import import_module
from pathlib import Path
from typing import Any


ALLOWED_OPERATIONS = {
    "frappe_explain_tongjianyun_nutrition_standard",
    "frappe_get_tongjianyun_weekly_nutrition_analysis",
    "frappe_list_tongjianyun_nutrition_rules",
}
SITE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def main() -> int:
    parser = argparse.ArgumentParser(description="Native Harness Frappe read bridge")
    parser.add_argument("--bench-root", required=True)
    parser.add_argument("--site", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--operation", required=True)
    args = parser.parse_args()

    if args.operation not in ALLOWED_OPERATIONS:
        return emit_error("operation is not allowlisted")
    if not SITE_PATTERN.fullmatch(args.site):
        return emit_error("site is invalid")
    if not args.user or "\n" in args.user or "\r" in args.user:
        return emit_error("user is invalid")

    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return emit_error(f"invalid request JSON: {exc}")
    if not isinstance(request, dict) or not isinstance(request.get("arguments", {}), dict):
        return emit_error("arguments must be an object")

    bench_root = Path(args.bench_root).resolve()
    sites_path = bench_root / "sites"
    if not bench_root.is_dir() or not sites_path.is_dir():
        return emit_error("configured Native Bench root is unavailable")
    # Bench apps are editable source, not a copied package snapshot. Importing
    # from this explicit root makes the active formula implementation visible.
    sys.path.insert(0, str(bench_root / "apps"))

    frappe = None
    try:
        import frappe

        frappe.init(site=args.site, sites_path=str(sites_path))
        frappe.connect()
        frappe.set_user(args.user)
        module = import_module("tongjianyun.mcp_tools")
        function = getattr(module, args.operation, None)
        if not callable(function):
            return emit_error("configured Tongjianyun app does not expose this read operation")
        arguments = dict(request["arguments"])
        # The UI-facing Harness schema contains convenience selectors. Keep
        # server calls compatible with the installed app's exact signatures.
        if args.operation == "frappe_explain_tongjianyun_nutrition_standard":
            for field in ("recipe", "standard_mode", "student_groups"):
                arguments.pop(field, None)
        elif args.operation == "frappe_get_tongjianyun_weekly_nutrition_analysis":
            for field in ("standard_mode", "student_groups"):
                arguments.pop(field, None)
        result = function(**arguments)
        return emit_ok(result)
    except Exception as exc:  # Frappe errors are returned as a structured failure.
        return emit_error(str(exc))
    finally:
        if frappe is not None:
            try:
                frappe.destroy()
            except Exception:
                pass


def emit_ok(result: Any) -> int:
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, default=str))
    return 0


def emit_error(message: str) -> int:
    print(json.dumps({"ok": False, "error": str(message)[:1000]}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
