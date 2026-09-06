---
description: "Read Native Bench Frappe records with bounded permissions, or apply approved scalar updates in a maintenance runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-native-bench-frappe

English | [中文](README.zh.md)

## Summary

Use this package to inspect safe Frappe metadata and read permitted business records from the active Native Bench. A maintenance runtime can also preview and apply approved scalar updates to existing records. An opt-in business runtime accepts only scoped reads under a signed, explicitly pinned user identity. Frappe permissions remain authoritative; the adapter is not a multi-user Web gateway.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package through a profile or Bundle patch. The deployment owns the Bench root, site, executable, account and scope; a model call cannot supply them.

### Maintenance configuration

This configuration retains discovery, description, list/get reads, update preview and approved update apply:

```yaml
- id: native-bench-frappe
  name: '@deepseek-ai/dsh-tool-native-bench-frappe'
  config:
    accessMode: maintenance
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

| Field | Default | Meaning |
|---|---|---|
| `accessMode` | `maintenance` | Business mode exposes only scoped describe/list/get operations. |
| `frappeUser` | Empty | Maintenance resolves empty to Administrator; business requires an explicit account. |
| `actorTokenFile` | Empty | Business requires an absolute path to a private signed assertion file. |
| `businessDoctypes` | Empty | Business requires 1–64 explicitly named DocTypes. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-native-bench-frappe) owns the full field contract. Maintenance rejects business credentials and scope instead of ignoring them.

### Business identity and reads

Business mode registers only description, list and get. Both the TypeScript client and Python entrypoint reject discovery, updates and out-of-scope DocTypes. The Python helper reads an owner-only regular POSIX assertion file of at most 4096 bytes; it rejects final-component symlinks and hardlinks. It delegates signature, site, expiry and account resolution to `ione_core.mcp.identity.resolve_actor_user`. The verified account must exactly match `frappeUser`, and both modes require an enabled System User.

A trusted bridge must supply and refresh one assertion for each isolated user runtime. This package does not issue assertions or associate shared Web sessions with users. Do not use the shared maintenance host as a staff deployment: other plugins, Web APIs, sessions and filesystem access need separate isolation.

List reads use structured filters, one-field sorting, up to 100 rows and up to 64 selected fields. Get reads use the same field limit. Protected infrastructure DocTypes and sensitive fields are excluded. Identity failures return fixed diagnostics; credential contents are absent from tool arguments, subprocess arguments and tool results.

### Approved maintenance updates

Preview checks an existing record and its proposed scalar changes without saving. Apply requires the exact preview id, document version and values, plus one-shot approval through Harness. It saves through the Frappe document lifecycle, so validation, hooks and ordinary Version tracking remain authoritative. Create, delete, submit, cancel, child-table and schema changes are not exposed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [plugin](src/index.ts) selects the tool surface and approval policy. The [client](src/native.ts) checks deployment scope before spawning the [Python helper](python/native_frappe_query.py). The helper checks policy before database startup, verifies the actor before business reads, and uses Frappe ORM permissions rather than arbitrary SQL or model-supplied Python. The [Loader tests](tests/loader-composition.spec.ts), [credential-free Python tests](tests/test_business_identity.py) and [recorded denial session](../../../snapshots/session/native-frappe-business-denial/session.jsonl) exercise the boundaries at different layers.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These owners cover the adjacent integration boundaries.

- [Native Bench source tools](../tool-native-bench-source/README.md) — source inspection and extension planning.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-native-bench-frappe) — model-facing parameter contracts.
- [Testing policy](../../../docs/testing.md) — focused tests and keyless session replay.

-----

<a id="model-experience"></a>
## Model Experience

### Native Bench Frappe platform tools

#### What the model sees

Maintenance contributes a routing section and six tool schemas; business contributes a scoped-read routing section and three schemas. Results contain bounded, sanitized metadata or records. The configured account, site path, assertion path and executable are not model-call parameters.

#### Token effect

The routing section is fixed for the selected mode. Row, field, input and output limits bound result size.

#### KV Cache effect

Changing the mounted mode changes the system-prompt and tool prefix. Database content does not change the prompt contribution.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The adapter constrains its own tools, not the complete application host.

- **No multi-user gateway** — session ownership, login handoff, assertion issuance and renewal belong to the trusted host integration.
- **No class-ownership policy** — a DocType allowlist does not restrict a teacher to one class; Frappe role and record permissions must enforce that separately.
- **No general workflow engine** — only approved maintenance scalar updates are writable; domain services must own other business transitions.
- **No host-wide isolation** — other plugins, Web APIs, attachments and filesystem access need independent authorization. Business mode must not be enabled on a shared maintenance host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
