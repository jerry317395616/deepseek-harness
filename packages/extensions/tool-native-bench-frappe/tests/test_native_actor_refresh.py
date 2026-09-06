"""Credential-free renewal tests; Frappe is the external account/signature adapter."""

import base64
from dataclasses import replace
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

PYTHON = Path(__file__).resolve().parents[1] / "python"
sys.path.insert(0, str(PYTHON))
import native_actor_refresh as renew
sys.path.pop(0)

USER = "teacher@example.test"
KEY = "fixture-signing-material-not-a-real-key"
SITE = "example.test"


@unittest.skipUnless(os.name == "posix", "Renewal requires private POSIX files")
class RenewalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bench = self.root / "bench"
        (self.bench / "sites" / SITE).mkdir(parents=True)
        self.home = self.root / "employee"
        self.home.mkdir(mode=0o700)
        self.output = self.home / "actor.assertion"
        self.path = self.root / "renew.json"
        self.raw = dict(version=1, bench_root=str(self.bench), site=SITE, user=USER,
                        assertion_file=str(self.output), ttl_seconds=300)
        self.save_config()
        self.config = renew.Configuration.load(str(self.path))

    def save_config(self):
        self.path.write_text(json.dumps(self.raw), encoding="utf-8")
        self.path.chmod(0o600)

    def account(self, **values):
        fields = dict(name=USER, email=USER, enabled=1, user_type="System User")
        fields.update(values)
        return SimpleNamespace(**fields)

    def frappe(self, account=None):
        return SimpleNamespace(
            db=SimpleNamespace(get_value=lambda *_a, **_k: account or self.account()),
            conf={"ione_agent_identity_shared_secret": KEY})

    def identity(self, user=USER):
        module = ModuleType("ione_core.mcp.identity")
        module.resolve_actor_user = lambda _token: user
        return patch.dict(sys.modules, {"ione_core.mcp.identity": module})

    def test_configuration_rejects_implicit_or_elevated_identity_and_bad_ttl(self):
        for field, value in (("user", "Guest"), ("user", "Administrator"), ("user", ""),
                             ("user", " teacher@example.test"), ("user", "a\nb"),
                             ("ttl_seconds", 901), ("ttl_seconds", 59),
                             ("ttl_seconds", True), ("version", True), ("site", "../other")):
            raw = dict(self.raw, **{field: value})
            self.path.write_text(json.dumps(raw), encoding="utf-8")
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                renew.Configuration.load(str(self.path))

    def test_configuration_refuses_unknown_fields_and_public_files(self):
        self.raw["extra"] = "not-accepted"
        self.save_config()
        with self.assertRaises(ValueError):
            renew.Configuration.load(str(self.path))
        self.raw.pop("extra")
        self.save_config()
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            renew.Configuration.load(str(self.path))

    def test_assertion_pins_exact_user_site_and_expiry_and_is_verifier_checked(self):
        with self.identity(), patch.object(renew.time, "time", return_value=1000):
            assertion = renew.issue_assertion(self.frappe(), self.config)
        prefix, body, signature = assertion.split(".")
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        self.assertEqual(prefix, "ione1")
        self.assertEqual(payload, dict(v=1, iss="ione-agent", iat=1000, exp=1300,
                                     aud=SITE, email=USER, user=USER))
        expected = hmac.new(KEY.encode(), (prefix + "." + body).encode(), hashlib.sha256).digest()
        self.assertEqual(base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)), expected)
        with self.identity("other@example.test"), self.assertRaises(ValueError):
            renew.issue_assertion(self.frappe(), self.config)

    def test_disabled_website_wrong_name_or_invalid_email_never_issues(self):
        for fields in ({"enabled": 0}, {"user_type": "Website User"}, {"name": "other"},
                       {"email": ""}, {"email": None}):
            with self.subTest(fields=fields), self.identity(), self.assertRaises(ValueError):
                renew.issue_assertion(self.frappe(self.account(**fields)), self.config)

    def test_short_signing_material_is_rejected(self):
        frappe = self.frappe()
        frappe.conf["ione_agent_identity_shared_secret"] = "invalid"
        with self.identity(), self.assertRaises(ValueError):
            renew.issue_assertion(frappe, self.config)

    def test_atomic_publication_keeps_private_mode_and_old_readers_complete(self):
        destination = renew.AssertionDestination(self.output)
        self.addCleanup(destination.close)
        destination.publish("fixture-first")
        with self.output.open("rb") as old_reader:
            destination.publish("fixture-second")
            self.assertEqual(old_reader.read(), b"fixture-first")
        self.assertEqual(self.output.read_bytes(), b"fixture-second")
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), ["actor.assertion"])

    def test_invalid_destination_never_modifies_link_target(self):
        target = self.root / "unrelated"
        target.write_text("preserve-me", encoding="utf-8")
        target.chmod(0o600)
        self.output.symlink_to(target)
        with self.assertRaises(ValueError):
            renew.AssertionDestination(self.output)
        self.assertEqual(target.read_text(), "preserve-me")
        self.output.unlink()
        os.link(target, self.output)
        with self.assertRaises(ValueError):
            renew.AssertionDestination(self.output)

    def test_public_directory_is_rejected(self):
        self.home.chmod(0o755)
        with self.assertRaises(ValueError):
            renew.AssertionDestination(self.output)

    def test_failed_replace_cleans_temporary_and_refresh_revokes_old_assertion(self):
        with patch.object(renew, "with_native_bench", return_value="fixture-old"):
            renew.refresh(self.config)
        with patch.object(renew, "with_native_bench", return_value="fixture-new"), patch.object(
                renew.os, "replace", side_effect=OSError("fixture-failure")), self.assertRaises(OSError):
            renew.refresh(self.config)
        self.assertEqual(list(self.home.iterdir()), [])

    def test_account_failure_revokes_prior_assertion_and_check_mode_does_not_write(self):
        with patch.object(renew, "with_native_bench", return_value="fixture-old"):
            renew.refresh(self.config)
            renew.refresh(self.config, check=True)
        self.assertEqual(self.output.read_text(), "fixture-old")
        with patch.object(renew, "with_native_bench", side_effect=ValueError("fixture-secret")):
            with self.assertRaises(ValueError):
                renew.refresh(self.config, check=True)
            self.assertTrue(self.output.exists())
            with self.assertRaises(ValueError):
                renew.refresh(self.config)
        self.assertFalse(self.output.exists())

    def test_cli_redacts_external_diagnostics(self):
        out, err = io.StringIO(), io.StringIO()

        def fail(*_args, **_kwargs):
            print("fixture-sensitive-stdout")
            print("fixture-sensitive-stderr", file=sys.stderr)
            raise RuntimeError(KEY)

        with patch.object(renew, "refresh", side_effect=fail), patch("sys.stdout", out), patch("sys.stderr", err):
            status = renew.main(["--config", str(self.path)])
        self.assertEqual(status, 1)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(err.getvalue(), "employee assertion refresh failed\n")

    def test_native_cleanup_restores_cwd_and_rolls_back_without_commit(self):
        calls = []
        frappe = ModuleType("frappe")
        frappe.local = SimpleNamespace(db=True)
        frappe.db = SimpleNamespace(rollback=lambda: calls.append("rollback"))
        frappe.init = lambda **_kw: calls.append("init")
        frappe.connect = lambda **_kw: calls.append("connect")
        frappe.destroy = lambda: calls.append("destroy")
        before = Path.cwd()
        with patch.dict(sys.modules, {"frappe": frappe}), patch.object(
                renew, "issue_assertion", side_effect=ValueError("fixture-error")), self.assertRaises(ValueError):
            renew.with_native_bench(self.config)
        self.assertEqual(Path.cwd(), before)
        self.assertEqual(calls, ["init", "connect", "rollback", "destroy"])

    def test_two_employee_destinations_do_not_share_assertions(self):
        other_home = self.root / "other"
        other_home.mkdir(mode=0o700)
        other = replace(self.config, user="other@example.test", assertion_file=other_home / "actor.assertion")
        with patch.object(renew, "with_native_bench", side_effect=lambda c: "fixture-" + c.user):
            renew.refresh(self.config)
            renew.refresh(other)
        self.assertEqual(self.output.read_text(), "fixture-" + USER)
        self.assertEqual(other.assertion_file.read_text(), "fixture-other@example.test")

    def test_real_cli_rejects_missing_config_without_traceback(self):
        env = {k: v for k, v in os.environ.items()
               if not any(word in k.upper() for word in ("KEY", "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL", "AUTH"))}
        result = subprocess.run([sys.executable, "-B", str(PYTHON / "native_actor_refresh.py"),
                                 "--config", str(self.root / "absent.json")],
                                capture_output=True, text=True, timeout=10, env=env)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "employee assertion refresh failed\n")


if __name__ == "__main__":
    unittest.main()
