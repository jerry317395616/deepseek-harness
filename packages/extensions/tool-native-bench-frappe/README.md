# `@deepseek-ai/dsh-tool-native-bench-frappe`

English | [中文](README.zh.md)

This package lets an agent discover the active Native Bench platform, inspect safe DocType metadata, read permitted business documents, and update approved scalar fields on existing records. Every operation runs through Frappe with a fixed deployment account, so permissions, document validation, hooks, and ordinary Version tracking remain authoritative. The bridge is local to the Bench: it does not call an HTTP MCP endpoint, execute arbitrary SQL, or evaluate model-supplied Python.

Configure it through a profile or Bundle patch. The deployment owns the Bench root, site, Python executable and fixed Frappe account; none of those values can be supplied by a model call.

```yaml
- id: native-bench-frappe
  name: '@deepseek-ai/dsh-tool-native-bench-frappe'
  config:
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

`native_bench_frappe_platform_catalog` returns installed applications and the current account's readable DocTypes, while `native_bench_frappe_describe_doctype` returns safe fields and effective CRUD permissions. `native_bench_frappe_list_documents` supports structured filters, one-field sorting, pagination up to 100 rows, and up to 64 explicitly named fields; `native_bench_frappe_get_document` reads one record with the same field limit. Protected infrastructure DocTypes (including users, roles, files, credentials, schema and system configuration) are denied, and sensitive field names are redacted.

An update is a two-call operation. `native_bench_frappe_preview_document_update` validates the record, fields, values and write permission without changing data, then returns a `preview_id` bound to the document's `modified` value and the requested changes. `native_bench_frappe_apply_document_update` requires the same arguments and id, asks the user for one-shot approval through the standard Harness approval service, rejects stale previews, and saves through the normal Frappe document lifecycle. Only existing business records and scalar fields are accepted.

The separate `@deepseek-ai/dsh-tool-native-bench-source` package searches and reads source files under the same Bench. Together they cover application source and permission-aware business data for all installed apps, not only Tongjianyun.

## Model Experience

### Native Bench Frappe platform tools

#### What the model sees

The package contributes a stable routing section and six schemas listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-native-bench-frappe): platform catalog, DocType description, list/get reads, update preview, and approved update apply. Tool results contain only bounded, sanitized metadata and records; the helper path, Python command, site path and fixed account are not model-visible parameters.

#### Token effect

The routing section is small and fixed. Result size is bounded by the row, field, input and output limits documented above and in the configuration schema.

#### KV Cache effect

Mounting or unmounting the package changes the system-prompt and tool prefix. Database contents do not change the package's prompt contribution.

## Known Limitations and Deferred Work

- **Existing-record scalar updates only** — create, delete, submit, cancel, child-table, attachment, schema, report and arbitrary SQL operations remain unavailable. Application-specific services must own workflows that need those operations.
- **Protected DocTypes** — security, credential, user, role, file, schema and system DocTypes are excluded even when the fixed Frappe account could otherwise access them.
- **Deployment-owned identity** — the fixed `frappeUser` must be managed by the deployment and granted only the roles required for the installed applications. It is never accepted from tool arguments.
