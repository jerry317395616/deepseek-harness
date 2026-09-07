"""Credential-free deployment checks; no production process or network dependency."""
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import ssl
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from email.message import Message

spec = importlib.util.spec_from_file_location(
    "preflight", Path(__file__).with_name("employee-deployment-preflight.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def candidate():
    properties = dict.fromkeys(preflight.PROPERTIES, "yes")
    properties.update(LoadState="loaded", ActiveState="active", MainPID="42",
                      ProtectSystem="strict", MemoryMax="1073741824", TasksMax="128")
    identity = {"uids": [2001] * 4, "gids": [2001] * 4, "groups": [],
                "no_new_privileges": True, "capabilities": 0}
    return properties, identity


class RuntimeTests(unittest.TestCase):
    def checks(self, props, identity):
        return preflight.runtime_checks(props, identity, 1000, 1000, {0, 27, 999})

    def test_empty_baseline_is_not_success(self):
        self.assertFalse(preflight.report({})["automated_baseline_passed"])

    def test_hardened_candidate_is_not_deployment_approval(self):
        checks = self.checks(*candidate())
        self.assertTrue(all(checks.values()))
        result = preflight.report(checks)
        self.assertTrue(result["automated_baseline_passed"])
        self.assertFalse(result["deployment_approved"])
        self.assertEqual(len(result["requires_separate_acceptance"]), 5)

    def test_shared_privileged_or_root_identity_is_rejected(self):
        for field, value, check in (
            ("uids", [1000] * 4, "runtime_distinct_unprivileged_uid"),
            ("uids", [0] * 4, "runtime_distinct_unprivileged_uid"),
            ("uids", [2001, 2001, 0, 2001], "runtime_distinct_unprivileged_uid"),
            ("gids", [1000] * 4, "runtime_no_privileged_groups"),
            ("groups", [999], "runtime_no_privileged_groups"),
            ("capabilities", 1, "runtime_no_effective_capabilities"),
            ("no_new_privileges", False, "runtime_no_new_privileges"),
        ):
            with self.subTest(field=field, value=value):
                props, identity = candidate()
                identity[field] = value
                self.assertFalse(self.checks(props, identity)[check])

    def test_each_required_service_property_has_a_negative_control(self):
        for field, check in (
            ("ActiveState", "runtime_active"), ("MainPID", "runtime_active"),
            ("ProtectHome", "runtime_protect_home"),
            ("ProtectSystem", "runtime_readonly_system"),
            ("PrivateTmp", "runtime_private_tmp"),
            ("PrivateDevices", "runtime_private_devices"),
            ("NoNewPrivileges", "runtime_no_new_privileges"),
            ("RestrictSUIDSGID", "runtime_restrict_suid"),
            ("MemoryMax", "runtime_memory_bound"), ("TasksMax", "runtime_task_bound"),
        ):
            with self.subTest(field=field):
                props, identity = candidate()
                props[field] = ""
                self.assertFalse(self.checks(props, identity)[check])

    def test_missing_observation_fails_closed(self):
        self.assertFalse(any(self.checks({}, None).values()))

    def test_unbounded_or_invalid_limits_rejected(self):
        for value in ("infinity", "", "0", "-1", "1.5", str(2**64 - 1), "９９"):
            self.assertFalse(preflight.finite_positive(value))
        self.assertTrue(preflight.finite_positive("128"))

    def test_process_restart_during_observation_fails_closed(self):
        props, identity = candidate()
        changed = {**props, "MainPID": "43"}
        with patch.object(preflight.BENCH.__class__, "stat", return_value=SimpleNamespace(st_uid=1000, st_gid=1000)), \
             patch.object(preflight, "service_properties", side_effect=[props, changed]), \
             patch.object(preflight, "read_identity", return_value=identity):
            self.assertFalse(any(preflight.collect_runtime("example.service", "user").values()))


class CollectionTests(unittest.TestCase):
    def test_only_safe_systemd_fields_and_environment_requested(self):
        props, _ = candidate()
        def run(argv, **kwargs):
            self.assertEqual(argv[:3], ["systemctl", "--user", "show"])
            self.assertEqual(argv[-1], "example.service")
            self.assertNotIn("Environment", argv[-2])
            self.assertNotIn("ExecStart", argv[-2])
            self.assertNotIn("SECRET_TEST", kwargs["env"])
            self.assertEqual(kwargs["timeout"], 10)
            self.assertTrue(kwargs["check"])
            return SimpleNamespace(stdout="\n".join(f"{k}={v}" for k, v in props.items()))
        with patch.dict(preflight.os.environ, {"SECRET_TEST": "not-for-child"}):
            self.assertEqual(preflight.service_properties("example.service", "user", run), props)

    def test_invalid_unit_is_rejected_before_spawn(self):
        def forbidden(*args, **kwargs):
            self.fail("invalid input reached subprocess")
        for value in ("--all", "x.service; touch /tmp/x", "/tmp/x.service", "a\nb.service"):
            with self.assertRaises(ValueError):
                preflight.service_properties(value, "user", forbidden)

    def test_missing_duplicate_and_unexpected_properties_rejected(self):
        props, _ = candidate()
        good = "\n".join(f"{k}={v}" for k, v in props.items())
        for output in ("", good + "\nMainPID=42", good + "\nEnvironment=hidden"):
            with self.assertRaises(ValueError):
                preflight.service_properties("example.service", "user",
                                             lambda *a, **kw: SimpleNamespace(stdout=output))

    def test_collection_errors_do_not_escape_to_report(self):
        with patch.object(preflight.BENCH.__class__, "stat", side_effect=OSError("DO_NOT_DISCLOSE")):
            text = json.dumps(preflight.report(preflight.collect_runtime("example.service", "user")))
        self.assertNotIn("DO_NOT_DISCLOSE", text)
        self.assertIn('"deployment_approved": false', text)


class HttpsTests(unittest.TestCase):
    def test_exact_frappe_login_handoff_target_required(self):
        target = preflight.LOGIN + "?redirect-to=%2Fapi%2Fmethod%2Fione_core.harness_auth.launch"
        self.assertTrue(preflight.is_login_redirect(302, target))
        for status, location in (
            (200, target), (302, target.replace("https:", "http:")),
            (302, target.replace("child.myyr.top", "evil.test")),
            (302, target + "&token=hidden"), (302, target + "#fragment"),
            (302, target.replace("child.myyr.top", "user@child.myyr.top")),
            (302, target.replace("harness_auth.launch", "other.launch")),
        ):
            self.assertFalse(preflight.is_login_redirect(status, location))

    def test_tls_failure_is_failure_without_exception_text(self):
        def failure(url):
            raise ssl.SSLError("DO_NOT_DISCLOSE")
        checks = preflight.https_checks(failure)
        self.assertFalse(any(checks.values()))
        self.assertNotIn("DO_NOT_DISCLOSE", json.dumps(preflight.report(checks)))

    def test_get_probes_have_no_credentials_and_close_redirect_response(self):
        headers = Message()
        headers["Location"] = preflight.LOGIN + "?redirect-to=%2Fapi%2Fmethod%2Fione_core.harness_auth.launch"
        headers["Set-Cookie"] = "DO_NOT_DISCLOSE"
        body = io.BytesIO(b"BODY_NOT_READ")
        response = HTTPError(preflight.HARNESS, 302, "Found", headers, body)
        def open_request(request, **kwargs):
            self.assertEqual(request.full_url, preflight.HARNESS)
            self.assertEqual(request.get_method(), "GET")
            self.assertEqual(request.header_items(), [])
            self.assertEqual(kwargs, {"timeout": 10})
            raise response
        with patch.object(preflight, "build_opener", return_value=SimpleNamespace(open=open_request)):
            status, location = preflight.probe_https(preflight.HARNESS)
        self.assertEqual(status, 302)
        self.assertNotIn("DO_NOT_DISCLOSE", location)
        self.assertTrue(body.closed)

    def test_http_denial_is_not_a_tls_failure(self):
        checks = preflight.https_checks(lambda url: (403, ""))
        self.assertTrue(checks["public_login_https_tls_verified"])
        self.assertTrue(checks["public_harness_redirect_tls_verified"])
        self.assertFalse(checks["public_login_https_response_expected"])
        self.assertFalse(checks["public_harness_redirect_response_expected"])

    def test_redirect_handler_never_follows(self):
        self.assertIsNone(preflight.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.test"))

    def test_probe_results_do_not_approve_deployment(self):
        target = preflight.LOGIN + "?redirect-to=%2Fapi%2Fmethod%2Fione_core.harness_auth.launch"
        checks = preflight.https_checks(lambda url: (200, "") if url == preflight.LOGIN else (302, target))
        self.assertTrue(all(checks.values()))
        self.assertFalse(preflight.report(checks)["deployment_approved"])


if __name__ == "__main__":
    unittest.main()
