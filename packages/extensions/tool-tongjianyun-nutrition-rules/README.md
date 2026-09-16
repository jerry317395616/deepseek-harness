---
description: "Tongjianyun nutrition analysis and controlled rule operations through Native Bench or authenticated MCP."
kind: "package-reference"
---

# `@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules`

English | [中文](README.zh.md)

## Summary

Query Tongjianyun nutrition data and, in explicitly configured MCP mode, manage nutrition rules and publish reports. Default native mode runs three permitted read operations in the configured Native Bench. The deployment fixes the Bench, site, Python environment, and Frappe account; the model cannot choose them. MCP calls require configured authentication and can use dynamic actor identity. The tool-timeout policy bounds each call.

## Table of Contents

- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known limitations](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configuration"></a>
## Configuration

No runtime invariant companion is published because this package has no independent event sequence or mutable relationship beyond the checks performed by its owning services.

```yaml
- id: tongjianyun-nutrition-rules
  name: '@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules'
  config:
    transport: native
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

For explicit MCP compatibility mode:

```yaml
- id: tongjianyun-nutrition-rules
  name: '@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules'
  config:
    transport: mcp
    endpoint: https://child.myyr.top/api/method/ione_core.mcp.server.handle_mcp
    credentialRef: IONE_TONGJIANYUN_MCP_TOKEN
    identitySecretRef: IONE_TONGJIANYUN_IDENTITY_SECRET
    identityEmail: ione-harness-integration@child.myyr.top
    identityUserHint: ione-harness-integration@child.myyr.top
    identityAudience: child.myyr.top
    timeoutMs: 30000
```

The identity-signing secret is resolved only inside the plugin and is never included in a model-visible schema, tool result, log message, or HTTP header. Keep the native Frappe account enabled as a dedicated service user with read roles (or use the deployment's explicitly approved administrator account); the helper does not accept arbitrary Python, SQL, site paths, or model-supplied users.

The Frappe account remains subject to Tongjianyun's role checks, audit trail, rule state transitions, and exact publish (`确认发布`) or rollback (`确认回滚`) confirmation. Native mode rejects all rule writes before starting a process. MCP mode checks destructive confirmation before sending the request and the server checks it again. A stable system-prompt section requires source evidence followed by local read-only data before answering standards or recipe questions. If the Frappe call fails, the model is instructed to report missing evidence instead of inventing a calculation.

Generated reports may be selected from the active Native Bench at `/home/zyd/frappe/native-bench` in addition to the legacy report roots. Source-code analysis itself is provided by the separate Native Bench source package; this package remains the permission-aware database and report bridge.

<a id="model-experience"></a>
## Model Experience

### Nutrition-rule tool schemas

#### What the model sees

The ten tool schemas are listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-tongjianyun-nutrition-rules). Tool results contain only the structured result returned by Frappe; API credentials, HTTP headers, the endpoint, and optional actor assertions never enter model context. The fixed routing section tells the model when to compare all age groups, explain one standard, or calculate a weekly recipe.

#### Token effect

One fixed native-tool schema set and one fixed routing section join each request while this plugin is mounted. Each completed call appends its structured nutrition result through the ordinary tool-result flow; result size is controlled by Tongjianyun's MCP response.

#### KV Cache effect

The schemas remain prefix-stable for a mounted plugin configuration. Mounting, unmounting, or changing the tool definitions replaces the tool-schema prefix and can invalidate reuse; credential rotations and per-call actor assertions do not change it.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Identity secret custody** — dynamic assertions require the Frappe site's identity-signing secret in the protected Harness credential store. Rotate the secret together with the site's identity configuration. `actorTokenRef` is retained only for trusted providers that already issue a fresh assertion per call; static long-lived user tokens are not supported.
- **Native mode is read-only** — rule drafts, submissions, publication, and rollback are rejected locally. Use MCP compatibility mode or the Frappe UI for writes.
- **Native account custody** — the fixed `frappeUser` must be managed by the deployment and granted only the roles required for the three reads. It is not a credential field and cannot be overridden by a model call.
- **Frappe result bounds** — the server owns pagination and payload limits for rule lists and previews. This plugin preserves the structured result and does not invent a second truncation policy.

<a id="dev-note"></a>
### Dev Note

None.
