---
description: "Find active Native Bench source and prohibit hosted DocType changes and arbitrary execution."
kind: "package-reference"
---
# @deepseek-ai/dsh-tool-native-bench-source

English | [中文](README.zh.md)

## Summary

Find the Frappe source serving the current site. Resolve routes and plan Tongjianyun extensions without editing upstream applications. An optional Host policy denies arbitrary execution and all DocType changes. Database access remains in the separate Frappe bridge.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the plugin through trusted profile configuration.

### When to choose it

Use active Bench source as evidence. Apply the business overlay when ordinary conversations must not edit code, customize schema or change their own tools; installing the package alone does not activate that policy.

### Minimal configuration

```yaml
- id: native-bench-source
  name: '@deepseek-ai/dsh-tool-native-bench-source'
  config:
    benchRoot: /home/zyd/frappe/native-bench

- id: native-bench-business-policy
  name: '@deepseek-ai/dsh-tool-native-bench-source/policy'
```

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-native-bench-source) owns all source settings. The policy subpath has no widening configuration. Apply the complete [business overlay](../../../docs/user/guide/native-bench-business.md) last to restrict Remote methods and execution providers.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Bounded reads and packaged ripgrep searches return source evidence without site credentials. Route resolution distinguishes Pages, Reports, Workspaces and DocTypes. Planning identifies read-only upstream files and Tongjianyun destinations, but edits nothing. Field planning and migration are rejected. Maintenance retains approved asset builds and cache clearing; the business policy denies that tool entirely.

The Host policy installs an early rejection hook and a monotonic global guard. Approval cannot override a guard denial, including in old coding sessions. Only named business operations are admitted. The Frappe adapter separately rejects structural and executable metadata, including direct adapter calls.

| Source | Responsibility |
|---|---|
| [index.ts](src/index.ts) | Evidence, route planning, fixed maintenance |
| [policy.ts](src/policy.ts) | Hosted admission policy |
| [tests](tests/policy.spec.ts) | Guard precedence and allowed operations |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Business overlay](../../../docs/user/guide/native-bench-business.md) — deployment.
- [Frappe bridge](../tool-native-bench-frappe/README.md) — record permissions.
- [Gateway](../../api/gateway/README.md) — Remote endpoint admission.

<a id="model-experience"></a>
## Model Experience

### Source evidence and business policy

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-native-bench-source) describes six evidence, planning and maintenance schemas. The policy states “禁止任何 DocType 新增、修改或删除”. Forbidden calls return a Chinese refusal even after approval. Missing UI executors must be reported rather than claimed as implemented.

#### Token effect

Providers contribute their schemas and bounded results. The policy adds fixed guidance; a complete business persona can replace provider prompt sections while keeping the restrictions. The Web recording pins the assembled prompt and schemas.

#### KV Cache effect

Configuration and preset changes replace the prompt prefix. Source contents and tool results do not change fixed policy text or schemas.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The policy restricts Harness tools, not every administrator path.

- **Trusted Host** — operators can replace plugins or configuration. Filesystem permissions and direct HTTP routes require separate controls.
- **Identity** — shared-login actor binding is not implemented here. Updates retain their deployed actor, preview, approval and Frappe checks.
- **UI composition** — planning does not provide a safe Page, Workspace or Report creation executor.
- **History** — old coding presets may expose schemas whose execution the global guard denies.
- **Source versions** — a source root is not a historical release hash.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The keyless native-bench-business Web recording exercises the shipped CLI. Python schema-freeze tests do not initialize a real site.

</details>
