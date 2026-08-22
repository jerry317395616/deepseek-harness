# `@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules`

English | [中文](README.zh.md)

Registers six native Harness tools for the Tongjianyun weekly-menu nutrition-rule lifecycle: inspect rules, create a draft, preview a draft, submit it for review, publish an approved rule, and roll a historical rule forward as a new published version. The package calls Tongjianyun's authenticated Frappe MCP method directly; it does not expose the MCP credential or optional current-user assertion in a model-visible schema or tool result.

Configure the package through a profile or Bundle patch. `credentialRef` names a credential-store value containing the Frappe integration account in `api_key:api_secret` form. `actorTokenRef` is optional and names a trusted, rotating current-user assertion resolved for every call; enable it only when the Tongjianyun server is configured to require it. `timeoutMs` is enforced by the Harness tool-timeout policy.

```yaml
- id: tongjianyun-nutrition-rules
  name: '@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules'
  config:
    endpoint: https://child.myyr.top/api/method/ione_core.mcp.server.handle_mcp
    credentialRef: IONE_TONGJIANYUN_MCP_TOKEN
    actorTokenRef: IONE_TONGJIANYUN_ACTOR_TOKEN
    timeoutMs: 30000
```

The Frappe integration account remains subject to Tongjianyun's server-side role checks, audit trail, rule state transitions, and the exact publish (`确认发布`) or rollback (`确认回滚`) confirmation. The plugin checks the destructive confirmation before sending the request; the server checks it again.

## Model Experience

### Nutrition-rule tool schemas

#### What the model sees

The six tool schemas are listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-tongjianyun-nutrition-rules). Tool results contain only the structured result returned by Frappe; API credentials, HTTP headers, the endpoint, and optional actor assertions never enter model context.

#### Token effect

One fixed native-tool schema set joins each request while this plugin is mounted. Each completed call appends its structured nutrition-rule result through the ordinary tool-result flow; result size is controlled by Tongjianyun's MCP response.

#### KV Cache effect

The schemas remain prefix-stable for a mounted plugin configuration. Mounting, unmounting, or changing the tool definitions replaces the tool-schema prefix and can invalidate reuse; credential rotations and per-call actor assertions do not change it.

## Known Limitations and Deferred Work

- **Trusted user assertion source** — `actorTokenRef` can only consume a credential provider that supplies a fresh assertion for the active Harness user. A static long-lived user token is not supported; deployments that enable actor enforcement need a trusted identity bridge that refreshes this reference.
- **Frappe result bounds** — the server owns pagination and payload limits for rule lists and previews. This plugin preserves the structured result and does not invent a second truncation policy.
