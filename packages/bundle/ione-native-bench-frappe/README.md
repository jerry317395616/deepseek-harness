# `@deepseek-ai/dsh-ione-native-bench-frappe`

English | [中文](README.zh.md)

This opt-in Bundle inserts `@deepseek-ai/dsh-tool-native-bench-frappe`. A later profile or home patch must enable the row and supply the deployment-owned Native Bench root and Frappe account.

```yaml
- id: native-bench-frappe
  name: '@deepseek-ai/dsh-tool-native-bench-frappe'
  disabled: false
  config:
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

The package provides bounded `list` and `get` tools for permitted Frappe DocTypes. It uses the local Frappe ORM, checks the fixed user's permissions, blocks infrastructure and credential DocTypes, redacts sensitive fields, and never accepts SQL or arbitrary Python. Source discovery remains the responsibility of the Native Bench source Bundle.

## Model Experience

### Bundle composition

#### What the model sees

The Bundle itself adds no prompt text; the inserted package contributes generic Frappe database read routing and the `native_bench_frappe_list_documents` / `native_bench_frappe_get_document` schemas documented in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-native-bench-frappe).

#### Token effect

Zero while the Bundle row is disabled. When enabled, the inserted package contributes its documented routing section and tools.

#### KV Cache effect

Enabling or disabling the Bundle changes the mounted prompt and tool prefix. Changes to database contents do not change the Bundle's prompt contribution.

## Known Limitations and Deferred Work

- **Deployment-owned activation** — the Bundle deliberately remains disabled until a profile supplies an explicit Native Bench root, site and fixed Frappe account.
- **Read-only database boundary** — inserts, updates, deletes, reports and schema changes remain separate approved workflows; this package never exposes arbitrary SQL or write operations.
- **Protected records** — credentials, users, roles, files, system configuration and other infrastructure DocTypes are excluded even when the Frappe account could otherwise read them.
