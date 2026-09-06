"""Credential-free policy tests for the packaged Native Bench Python helper."""

import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[1] / "python" / "native_frappe_query.py"
SPEC = importlib.util.spec_from_file_location("native_frappe_business_test", HELPER)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def settings(**changes):
    values = dict(access_mode="business", operation="frappe_get_document",
                  actor_token_file="/private/actor.assertion", user="teacher@example.test",
                  business_doctypes='["Student"]')
    values.update(changes)
    return SimpleNamespace(**values)


class PolicyTests(unittest.TestCase):
    def test_only_scoped_reads_are_allowed(self):
        bridge.validate_access_policy(settings(), {"doctype": "Student"})
        for operation in ("frappe_platform_catalog", "frappe_preview_document_update",
                          "frappe_apply_document_update", "arbitrary_python"):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                bridge.validate_access_policy(settings(operation=operation), {"doctype": "Student"})
        with self.assertRaises(PermissionError):
            bridge.validate_access_policy(settings(), {"doctype": "Sales Invoice"})

    def test_scope_and_actor_must_be_explicit(self):
        for scope in ("[]", "{}", '[""]', '[" Student"]', "[1]", "null",
                      '["Student\\n"]', '["Student\\u0000"]', "invalid"):
            with self.subTest(scope=scope), self.assertRaises((ValueError, PermissionError)):
                bridge.validate_access_policy(settings(business_doctypes=scope), {"doctype": "Student"})
        for fields in ({"user": "Guest"}, {"actor_token_file": ""}, {"actor_token_file": "relative"}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                bridge.validate_access_policy(settings(**fields), {"doctype": "Student"})

    def test_cli_denials_are_json_and_precede_database_startup(self):
        argv = ["native_frappe_query.py", "--bench-root", "/nonexistent/native-bench",
                "--site", "example.test", "--user", "teacher@example.test",
                "--operation", "frappe_get_document", "--access-mode", "business",
                "--actor-token-file", "/private/actor.assertion",
                "--business-doctypes", '["Student"]',
                "--max-input-bytes", "16384", "--max-output-bytes", "16384"]
        request = json.dumps({"arguments": {"doctype": "Sales Invoice", "name": "INV-001"}})
        output = io.StringIO()
        with patch("sys.argv", argv), patch("sys.stdin", io.StringIO(request)), patch(
                "sys.stdout", output), patch.object(
                bridge.Path, "resolve", side_effect=AssertionError("database startup reached")):
            self.assertEqual(bridge.main(), 1)
        result = json.loads(output.getvalue())
        self.assertFalse(result["ok"])
        self.assertIn("outside the configured business scope", result["error"])

    def test_maintenance_cannot_accept_business_credentials(self):
        with self.assertRaises(ValueError):
            bridge.validate_access_policy(settings(access_mode="maintenance"), {})
        bridge.validate_access_policy(settings(access_mode="maintenance", actor_token_file="",
                                              business_doctypes="[]"), {})


@unittest.skipUnless(os.name == "posix", "Native Bench assertion files require POSIX permissions")
class AssertionFileTests(unittest.TestCase):
    def test_private_bounded_ascii_regular_file(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "assertion"
            path.write_text("fixture-assertion", encoding="ascii")
            path.chmod(0o600)
            self.assertEqual(bridge.read_actor_assertion(str(path)), "fixture-assertion")
            path.chmod(0o644)
            with self.assertRaises(PermissionError):
                bridge.read_actor_assertion(str(path))
            path.chmod(0o600)
            for content in (b"", b"a" * 4097, b"\xff"):
                path.write_bytes(content)
                with self.assertRaises(PermissionError):
                    bridge.read_actor_assertion(str(path))

    def test_links_missing_files_and_directories_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "assertion"
            path.write_text("fixture-assertion", encoding="ascii")
            path.chmod(0o600)
            symlink = Path(root) / "link"
            symlink.symlink_to(path)
            for invalid in (symlink, Path(root) / "missing", Path(root)):
                with self.subTest(path=invalid.name), self.assertRaises(PermissionError):
                    bridge.read_actor_assertion(str(invalid))
            os.link(path, Path(root) / "hardlink")
            with self.assertRaises(PermissionError):
                bridge.read_actor_assertion(str(path))


class ActorTests(unittest.TestCase):
    def test_signed_actor_must_match_pinned_user_and_still_be_enabled(self):
        account = SimpleNamespace(enabled=1, user_type="System User")
        frappe = SimpleNamespace(db=SimpleNamespace(get_value=lambda *_a, **_k: account))
        identity = ModuleType("ione_core.mcp.identity")
        identity.resolve_actor_user = lambda _token: "teacher@example.test"
        with patch.dict("sys.modules", {"ione_core.mcp.identity": identity}), patch.object(
                bridge, "read_actor_assertion", return_value="fixture-assertion"):
            self.assertEqual(bridge.resolve_execution_user(frappe, settings()), "teacher@example.test")
            with self.assertRaises(PermissionError):
                bridge.resolve_execution_user(frappe, settings(user="Administrator"))
            account.enabled = 0
            with self.assertRaises(PermissionError):
                bridge.resolve_execution_user(frappe, settings())
            account.enabled = 1
            account.user_type = "Website User"
            with self.assertRaises(PermissionError):
                bridge.resolve_execution_user(frappe, settings())

    def test_rejected_assertions_never_echo_credentials(self):
        identity = ModuleType("ione_core.mcp.identity")
        def reject(_token):
            raise ValueError("fixture-private-value")
        identity.resolve_actor_user = reject
        with patch.dict("sys.modules", {"ione_core.mcp.identity": identity}), patch.object(
                bridge, "read_actor_assertion", return_value="fixture-private-value"):
            with self.assertRaisesRegex(PermissionError, "verification failed") as result:
                bridge.resolve_execution_user(None, settings())
            self.assertNotIn("fixture-private-value", str(result.exception))

    def test_maintenance_rejects_guest_missing_disabled_and_website_accounts(self):
        for account in (None, SimpleNamespace(enabled=0, user_type="System User"),
                        SimpleNamespace(enabled=1, user_type="Website User")):
            frappe = SimpleNamespace(db=SimpleNamespace(get_value=lambda *_a, **_k: account))
            with self.assertRaises(PermissionError):
                bridge.resolve_execution_user(frappe, settings(access_mode="maintenance"))
        with self.assertRaises(PermissionError):
            bridge.resolve_execution_user(None, settings(access_mode="maintenance", user="Guest"))


if __name__ == "__main__":
    unittest.main()
