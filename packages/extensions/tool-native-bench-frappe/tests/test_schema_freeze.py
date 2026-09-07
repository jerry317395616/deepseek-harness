"""Metadata must be rejected before either CLI or direct bridge execution."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "python" / "native_frappe_query.py"
spec = importlib.util.spec_from_file_location("schema_freeze_query", path)
query = importlib.util.module_from_spec(spec)
spec.loader.exec_module(query)


class SchemaFreezeTests(unittest.TestCase):
    def test_all_protected_records_are_denied_for_preview_and_apply(self):
        for doctype in query.DENIED_DOCTYPES:
            for operation in ("frappe_preview_document_update", "frappe_apply_document_update"):
                with self.subTest(doctype=doctype, operation=operation):
                    args = {"doctype": f"  {doctype.upper()}  ", "name": "example",
                            "changes": {"label": "changed"}, "preview_id": "a" * 64}
                    with self.assertRaisesRegex(ValueError, "protected"):
                        query.normalize_arguments(operation, args)
                    # None has no DB methods; a failure after dispatch would not satisfy this assertion.
                    with self.assertRaisesRegex(ValueError, "protected"):
                        query.run_operation(None, operation, args, "Administrator")

    def test_indirect_structure_and_code_carriers_are_protected(self):
        required = {"doctype", "docfield", "docperm", "custom field", "property setter",
                    "custom docperm", "server script", "client script", "customize form",
                    "doctype action", "doctype link", "doctype state", "doctype layout",
                    "document naming rule", "workflow", "notification", "page", "report",
                    "workspace", "web page", "web template", "print format", "custom html block"}
        self.assertLessEqual(required, query.DENIED_DOCTYPES)

    def test_ordinary_record_updates_still_normalize(self):
        for doctype in ("Student", "Student Group", "Item", "Tongjianyun Recipe"):
            args = {"doctype": doctype, "name": "example", "changes": {"description": "business data"}}
            self.assertEqual(query.normalize_arguments("frappe_preview_document_update", args), args)

    def test_unknown_direct_operation_does_not_reach_frappe(self):
        with self.assertRaisesRegex(ValueError, "allowlisted"):
            query.run_operation(None, "execute_python", {}, "Administrator")


if __name__ == "__main__":
    unittest.main()
