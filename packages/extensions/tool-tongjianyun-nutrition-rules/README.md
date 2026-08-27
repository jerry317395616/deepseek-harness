# `@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules`

English | [中文](README.zh.md)

Registers nine native Harness tools for Tongjianyun weekly-menu nutrition. Three read-only tools explain one standard, compare the 4-, 5-, and 6-year-old standards in one operation, and calculate the latest or selected recipe from real Tongjianyun data. Six controlled tools cover the nutrition-rule lifecycle: inspect rules, create a draft, preview a draft, submit it for review, publish an approved rule, and roll a historical rule forward as a new published version. The package calls Tongjianyun's authenticated Frappe MCP method directly; it does not expose the MCP credential or optional current-user assertion in a model-visible schema or tool result.

Configure the package through a profile or Bundle patch. `credentialRef` names a credential-store value containing the Frappe integration account in `api_key:api_secret` form. For a Tongjianyun site that enforces actor assertions, prefer the dynamic identity configuration below: `identitySecretRef` points to the site identity-signing secret, while `identityEmail`, `identityUserHint`, and `identityAudience` describe the dedicated Frappe account. The plugin mints a fresh short-lived assertion for each request, so no expiring actor token is stored. `actorTokenRef` remains a legacy fallback for deployments that already provide a trusted rotating assertion. `timeoutMs` is enforced by the Harness tool-timeout policy.

```yaml
- id: tongjianyun-nutrition-rules
  name: '@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules'
  config:
    endpoint: https://child.myyr.top/api/method/ione_core.mcp.server.handle_mcp
    credentialRef: IONE_TONGJIANYUN_MCP_TOKEN
    identitySecretRef: IONE_TONGJIANYUN_IDENTITY_SECRET
    identityEmail: ione-harness-integration@child.myyr.top
    identityUserHint: ione-harness-integration@child.myyr.top
    identityAudience: child.myyr.top
    timeoutMs: 30000
```

The identity-signing secret is resolved only inside the plugin and is never included in a model-visible schema, tool result, log message, or HTTP header. Keep the Frappe integration account enabled as a dedicated service user and grant the required server-side roles there; the plugin does not bypass Frappe permissions or the MCP deny list.

The Frappe integration account remains subject to Tongjianyun's server-side role checks, audit trail, rule state transitions, and the exact publish (`确认发布`) or rollback (`确认回滚`) confirmation. The plugin checks the destructive confirmation before sending the request; the server checks it again. A stable system-prompt section requires the model to use the read-only evidence tools before answering questions about Tongjianyun standards or actual recipe results. If the Frappe call fails, the model is instructed to report the missing evidence instead of inventing a calculation.

Generated reports may be selected from the active Native Bench at `/home/zyd/frappe/native-bench` in addition to the legacy report roots. Source-code analysis itself is provided by the separate Native Bench source package; this package remains the permission-aware database and report bridge.

## Model Experience

### Nutrition-rule tool schemas

#### What the model sees

The nine tool schemas are listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-tongjianyun-nutrition-rules). Tool results contain only the structured result returned by Frappe; API credentials, HTTP headers, the endpoint, and optional actor assertions never enter model context. The fixed routing section tells the model when to compare all age groups, explain one standard, or calculate a weekly recipe.

#### Token effect

One fixed native-tool schema set and one fixed routing section join each request while this plugin is mounted. Each completed call appends its structured nutrition result through the ordinary tool-result flow; result size is controlled by Tongjianyun's MCP response.

#### KV Cache effect

The schemas remain prefix-stable for a mounted plugin configuration. Mounting, unmounting, or changing the tool definitions replaces the tool-schema prefix and can invalidate reuse; credential rotations and per-call actor assertions do not change it.

## Known Limitations and Deferred Work

- **Identity secret custody** — dynamic assertions require the Frappe site's identity-signing secret in the protected Harness credential store. Rotate the secret together with the site's identity configuration. `actorTokenRef` is retained only for trusted providers that already issue a fresh assertion per call; static long-lived user tokens are not supported.
- **Frappe result bounds** — the server owns pagination and payload limits for rule lists and previews. This plugin preserves the structured result and does not invent a second truncation policy.
