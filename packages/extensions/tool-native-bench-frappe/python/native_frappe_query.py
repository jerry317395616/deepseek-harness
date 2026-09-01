"""Bounded, permission-aware read bridge into the active Native Bench Frappe site.

This helper intentionally exposes only Frappe ORM list/get operations. It never
accepts SQL, Python source, a site path, or a model-selected Frappe user. The
deployment-owned account and the Frappe permission layer remain authoritative.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ALLOWED_OPERATIONS = {"frappe_list_documents", "frappe_get_document"}
SITE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
FIELD_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ORDER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\s+(?:asc|desc))?$", re.IGNORECASE)
OPERATORS = {"=", "!=", ">", "<", ">=", "<=", "like", "not like", "in", "not in", "between", "is"}
MAX_FIELDS = 64
MAX_FILTERS = 32
MAX_ROWS = 100
MAX_START = 100_000
MAX_STRING_LENGTH = 2_048
SENSITIVE_FIELD_PATTERN = re.compile(
    r"(?:password|secret|token|api[_-]?key|api[_-]?secret|credential|authorization|private[_-]?key)",
    re.IGNORECASE,
)

# Security and infrastructure records are never exposed through this generic
# reader. Business DocTypes still pass Frappe's own permission checks.
DENIED_DOCTYPES = {
    "access log",
    "activity log",
    "api request log",
    "auth token",
    "client script",
    "communication",
    "connected app",
    "custom field",
    "custom docperm",
    "doctype",
    "docperm",
    "email account",
    "email queue",
    "event streaming",
    "file",
    "has role",
    "integration request",
    "module def",
    "oauth authorization code",
    "oauth bearer token",
    "oauth client",
    "package",
    "package import",
    "password",
    "property setter",
    "rq job",
    "role",
    "role profile",
    "role profile role",
    "scheduled job log",
    "session default settings",
    "social login key",
    "system settings",
    "user",
    "user permission",
    "webhook",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Native Harness Frappe ORM read bridge")
    parser.add_argument("--bench-root", required=True)
    parser.add_argument("--site", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--operation", required=True)
    parser.add_argument("--max-input-bytes", required=True, type=int)
    parser.add_argument("--max-output-bytes", required=True, type=int)
    args = parser.parse_args()

    if args.operation not in ALLOWED_OPERATIONS:
        return emit_error("operation is not allowlisted")
    if not SITE_PATTERN.fullmatch(args.site):
        return emit_error("site is invalid")
    if not args.user or "\n" in args.user or "\r" in args.user:
        return emit_error("user is invalid")
    if args.max_input_bytes < 16_384 or args.max_input_bytes > 1_000_000:
        return emit_error("input limit is invalid")
    if args.max_output_bytes < 16_384 or args.max_output_bytes > 5_000_000:
        return emit_error("output limit is invalid")

    raw = sys.stdin.read(args.max_input_bytes + 1)
    if len(raw.encode("utf-8")) > args.max_input_bytes:
        return emit_error("request exceeds input limit")
    try:
        request = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return emit_error(f"invalid request JSON: {exc}")
    if not isinstance(request, dict) or not isinstance(request.get("arguments", {}), dict):
        return emit_error("arguments must be an object")

    arguments = dict(request["arguments"])
    try:
        normalized = normalize_arguments(args.operation, arguments)
    except ValueError as exc:
        return emit_error(str(exc))

    bench_root = Path(args.bench_root).resolve()
    sites_path = bench_root / "sites"
    if not bench_root.is_dir() or not sites_path.is_dir():
        return emit_error("configured Native Bench root is unavailable")
    # Bench apps are editable source, not a copied package snapshot.
    sys.path.insert(0, str(bench_root / "apps"))

    frappe = None
    try:
        import frappe

        frappe.init(site=args.site, sites_path=str(sites_path))
        frappe.connect()
        frappe.set_user(args.user)
        result = run_operation(frappe, args.operation, normalized)
        return emit_ok(result, args.max_output_bytes)
    except Exception as exc:  # Frappe errors become structured, bounded failures.
        return emit_error(str(exc))
    finally:
        if frappe is not None:
            try:
                frappe.destroy()
            except Exception:
                pass


def normalize_arguments(operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    doctype = arguments.get("doctype")
    if not isinstance(doctype, str) or not doctype.strip() or len(doctype) > 140 or "\n" in doctype or "\r" in doctype:
        raise ValueError("doctype must be a single non-empty name")
    doctype = doctype.strip()
    if doctype.lower() in DENIED_DOCTYPES:
        raise ValueError("this DocType is protected and cannot be read through the generic bridge")
    if doctype.startswith("__"):
        raise ValueError("internal DocTypes are not available")

    fields = arguments.get("fields", ["name"])
    validate_fields(fields)
    filters = arguments.get("filters", {})
    validate_filters(filters)
    order_by = arguments.get("order_by")
    if order_by is not None and (not isinstance(order_by, str) or not ORDER_PATTERN.fullmatch(order_by)):
        raise ValueError("order_by contains an unsupported expression")

    limit = arguments.get("limit", 20)
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > MAX_ROWS:
        raise ValueError("limit must be an integer from 1 to 100")
    start = arguments.get("start", 0)
    if not isinstance(start, int) or isinstance(start, bool) or start < 0 or start > MAX_START:
        raise ValueError("start must be an integer from 0 to 100000")

    normalized = {"doctype": doctype.strip(), "fields": fields, "filters": filters}
    if order_by is not None:
        normalized["order_by"] = order_by
    if operation == "frappe_list_documents":
        normalized["limit"] = limit
        normalized["start"] = start
    else:
        name = arguments.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 140 or "\n" in name or "\r" in name:
            raise ValueError("document name must be a single non-empty name")
        normalized["name"] = name.strip()
    return normalized


def validate_fields(value: Any) -> None:
    if not isinstance(value, list) or len(value) == 0 or len(value) > MAX_FIELDS:
        raise ValueError("fields must be an array of 1 to 64 names")
    for field in value:
        if not isinstance(field, str) or not FIELD_PATTERN.fullmatch(field) or SENSITIVE_FIELD_PATTERN.search(field):
            raise ValueError("fields contain an unsupported or sensitive name")


def validate_filters(value: Any) -> None:
    if isinstance(value, dict):
        if len(value) > MAX_FILTERS:
            raise ValueError("filters contain too many fields")
        for field, filter_value in value.items():
            if not isinstance(field, str) or not FIELD_PATTERN.fullmatch(field):
                raise ValueError("filters contain an unsupported field")
            validate_filter_value(filter_value)
        return
    if isinstance(value, list):
        if len(value) > MAX_FILTERS:
            raise ValueError("filters contain too many conditions")
        for condition in value:
            if (
                not isinstance(condition, list)
                or len(condition) != 3
                or not isinstance(condition[0], str)
                or not FIELD_PATTERN.fullmatch(condition[0])
                or not isinstance(condition[1], str)
                or condition[1].lower() not in OPERATORS
            ):
                raise ValueError("filters contain an unsupported condition")
            validate_filter_value(condition[2])
        return
    raise ValueError("filters must be an object or condition array")


def validate_filter_value(value: Any) -> None:
    if isinstance(value, dict) or (isinstance(value, list) and (len(value) > 100 or any(isinstance(item, (dict, list)) for item in value))):
        raise ValueError("filter values are too complex")
    if not isinstance(value, (str, int, float, bool, list)) and value is not None:
        raise ValueError("filter values must be JSON scalars or scalar arrays")


def run_operation(frappe: Any, operation: str, arguments: dict[str, Any]) -> Any:
    doctype = arguments["doctype"]
    if not frappe.has_permission(doctype, ptype="read"):
        raise PermissionError(f"Frappe user has no read permission for DocType: {doctype}")
    fields = arguments["fields"]
    if operation == "frappe_list_documents":
        return {
            "doctype": doctype,
            "rows": sanitize(frappe.get_list(
                doctype,
                fields=fields,
                filters=arguments["filters"],
                order_by=arguments.get("order_by"),
                limit_start=arguments["start"],
                limit_page_length=arguments["limit"],
            )),
            "limit": arguments["limit"],
            "start": arguments["start"],
        }
    rows = frappe.get_list(
        doctype,
        fields=fields,
        filters=[["name", "=", arguments["name"]]],
        limit_page_length=1,
    )
    return {"doctype": doctype, "name": arguments["name"], "document": sanitize(rows[0]) if rows else None}


def sanitize(value: Any, key: str | None = None, depth: int = 0) -> Any:
    if key is not None and SENSITIVE_FIELD_PATTERN.search(key):
        return "[redacted]"
    if depth > 8:
        return "[depth limited]"
    if isinstance(value, dict):
        return {str(item_key): sanitize(item_value, str(item_key), depth + 1) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [sanitize(item, None, depth + 1) for item in value[:MAX_ROWS]]
    if isinstance(value, str):
        return value[:MAX_STRING_LENGTH]
    return value


def emit_ok(result: Any, max_output_bytes: int) -> int:
    payload = json.dumps({"ok": True, "result": result}, ensure_ascii=False, default=str)
    if len(payload.encode("utf-8")) > max_output_bytes:
        return emit_error("result exceeds output limit")
    print(payload)
    return 0


def emit_error(message: str) -> int:
    print(json.dumps({"ok": False, "error": str(message)[:1000]}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
