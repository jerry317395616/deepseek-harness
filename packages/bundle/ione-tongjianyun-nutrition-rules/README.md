# `@deepseek-ai/dsh-ione-tongjianyun-nutrition-rules`

English | [中文](README.zh.md)

An opt-in Bundle that inserts the [Tongjianyun nutrition-rule tool](../../extensions/tool-tongjianyun-nutrition-rules/README.md) row into a Harness profile. The row is disabled by default because the Frappe endpoint and credential references are deployment-owned; installing a Bundle must never guess an endpoint or place secrets in a repository.

Enable it in a later profile or home `cordis.patch.yml` with the complete row configuration:

```yaml
- id: tongjianyun-nutrition-rules
  disabled: false
  config:
    endpoint: https://child.myyr.top/api/method/ione_core.mcp.server.handle_mcp
    credentialRef: IONE_TONGJIANYUN_MCP_TOKEN
    actorTokenRef: IONE_TONGJIANYUN_ACTOR_TOKEN
    timeoutMs: 30000
```

The referenced credential values belong in the Harness credential store, not in the patch. Omit `actorTokenRef` when the Tongjianyun server does not require a current-user assertion.

## Model Experience

### Opt-in nutrition-rule tool row

#### What the model sees

Nothing while disabled. When enabled, the [Tongjianyun nutrition-rule tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-tongjianyun-nutrition-rules) and their structured results become model-visible through the mounted tool package.

#### Token effect

The Bundle adds no prompt or schema itself. Enabling its row adds the six fixed tool schemas and ordinary tool-result payloads owned by the tool package.

#### KV Cache effect

None while disabled. Enabling, disabling, or changing the inserted tool row changes the mounted tool-schema prefix and can invalidate reuse.

## Known Limitations and Deferred Work

- **Deployment configuration is required** — the Bundle cannot enable itself because the Frappe MCP endpoint and credential references are site-specific. A later patch must provide the complete configuration before the tools appear.
