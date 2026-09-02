---
description: "Opt-in Bundle for the permission-aware Native Bench Frappe platform tools."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-ione-native-bench-frappe`

English | [中文](README.zh.md)

## Summary

This opt-in Bundle inserts `@deepseek-ai/dsh-tool-native-bench-frappe`. A later profile or home patch must enable the row and supply the deployment-owned Native Bench root, site, and Frappe account.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

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

The package provides platform catalog and DocType metadata tools, bounded `list` and `get` reads, and a preview-plus-approval update flow for scalar fields on existing business records. It uses the local Frappe document API, checks the fixed user's permissions, blocks infrastructure, schema, and credential DocTypes, redacts sensitive fields, and never accepts SQL or arbitrary Python. Source discovery remains the responsibility of the Native Bench source Bundle.

-----

<a id="model-experience"></a>

## Model Experience

### Bundle composition

#### What the model sees

The Bundle itself adds no prompt text; the inserted package contributes Frappe platform routing and the six discovery, read, preview, and apply schemas documented in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-native-bench-frappe).

#### Token effect

Zero while the Bundle row is disabled. When enabled, the inserted package contributes its documented routing section and tools.

#### KV Cache effect

Enabling or disabling the Bundle changes the mounted prompt and tool prefix. Changes to database contents do not change the Bundle's prompt contribution.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Deployment-owned activation** — the Bundle deliberately remains disabled until a profile supplies an explicit Native Bench root, site and fixed Frappe account.
- **Narrow write boundary** — only approved scalar updates to existing business records are available. Create, delete, submit, cancel, child-table, report, schema, and arbitrary SQL operations remain unavailable.
- **Protected records** — credentials, users, roles, files, system configuration and other infrastructure DocTypes are excluded even when the Frappe account could otherwise read them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The implementation and deployment boundary are recorded in the [Native Bench evidence Agent Note](../../../.agents/notes/implemented/architecture/2026-08-27-native-bench-source-evidence.md).

</details>
