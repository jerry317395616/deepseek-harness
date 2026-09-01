# `@deepseek-ai/dsh-tool-native-bench-frappe`

English | [中文](README.zh.md)

This package provides two model-facing, read-only tools for the active Native Bench Frappe site. They list and retrieve records from permitted DocTypes through Frappe's ORM, so the fixed deployment account's permissions and the site's business rules remain authoritative. The bridge is local to the Bench: it does not call an HTTP MCP endpoint, execute arbitrary SQL, or evaluate model-supplied Python.

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

`native_bench_frappe_list_documents` supports structured filters, one-field sorting, pagination up to 100 rows, and up to 64 explicitly named fields. `native_bench_frappe_get_document` reads one record with the same field boundary. Protected infrastructure DocTypes (including users, roles, files, credentials and system configuration) are denied and sensitive field names are redacted. Frappe read permissions are checked before every request.

The separate `@deepseek-ai/dsh-tool-native-bench-source` package searches and reads source files under the same Bench. Together they cover application source and permission-aware business data for all installed apps, not only Tongjianyun.

## Model Experience

### Native Bench Frappe read tools

#### What the model sees

The package contributes a stable routing section and the `native_bench_frappe_list_documents` / `native_bench_frappe_get_document` schemas listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-native-bench-frappe). Tool results contain only bounded, sanitized Frappe records; the helper path, Python command, site path and fixed account are not model-visible parameters.

#### Token effect

The routing section is small and fixed. Result size is bounded by the row, field, input and output limits documented above and in the configuration schema.

#### KV Cache effect

Mounting or unmounting the package changes the system-prompt and tool prefix. Database contents do not change the package's prompt contribution.

## Known Limitations and Deferred Work

- **Read-only database boundary** — this package does not insert, update or delete records, alter schema, run reports, or execute arbitrary SQL. Those operations require a separate approved management workflow.
- **Protected DocTypes** — security, credential, user, role, file and system DocTypes are excluded even when the fixed Frappe account could otherwise read them.
- **Deployment-owned identity** — the fixed `frappeUser` must be managed by the deployment and granted only the roles required for the installed applications. It is never accepted from tool arguments.
