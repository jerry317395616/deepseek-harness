# `@deepseek-ai/dsh-ione-tongjianyun-nutrition-rules`

English | [中文](README.zh.md)

An opt-in Bundle that inserts the [Tongjianyun nutrition-rule tool](../../extensions/tool-tongjianyun-nutrition-rules/README.md) row into a Harness profile. The row is disabled by default because the active Bench root, Frappe site, and service account are deployment-owned. Native mode is the default once enabled; it reads through the local Frappe ORM without an HTTP/MCP hop. MCP remains an explicit compatibility mode for deployments that need authenticated rule-write operations.

Enable it in a later profile or home `cordis.patch.yml` with the complete row configuration:

```yaml
- id: tongjianyun-nutrition-rules
  disabled: false
  config:
    transport: native
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

For explicit MCP compatibility mode, set `transport: mcp`, `endpoint`, and `credentialRef`; keep all credential values in the Harness credential store. Native mode supports read-only standard, weekly-analysis, and rule-list calls. Rule changes require the MCP compatibility mode or the Frappe administration UI.

## Model Experience

### Opt-in nutrition-rule tool row

#### What the model sees

Nothing while disabled. When enabled, the [Tongjianyun nutrition-rule tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-tongjianyun-nutrition-rules) and their structured results become model-visible through the mounted tool package.

#### Token effect

The Bundle adds no prompt or schema itself. Enabling its row adds the eight fixed tool schemas, one fixed evidence-routing prompt section, and ordinary tool-result payloads owned by the tool package.

#### KV Cache effect

None while disabled. Enabling, disabling, or changing the inserted tool row changes the mounted tool-schema prefix and can invalidate reuse.

## Known Limitations and Deferred Work

- **Deployment configuration is required** — the Bundle cannot enable itself because the active Bench root, Frappe site, and service account are site-specific. A later patch must provide the complete configuration before the tools appear.
- **Native mode is intentionally read-only** — write lifecycle operations are rejected locally so a model cannot mutate the database outside the audited Frappe workflow.
