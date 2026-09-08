---
description: "Opt-in Bundle for the synchronized official Frappe documentation retrieval tools."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-ione-frappe-docs`

English | [中文](README.zh.md)

## Summary

This opt-in Bundle inserts `@deepseek-ai/dsh-tool-frappe-docs`. A later profile or home patch enables the row and supplies the deployment-owned knowledge-base path. The Bundle does not synchronize content; operators run the packaged synchronization helper separately.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>

## Use this package

```yaml
- id: frappe-docs
  name: '@deepseek-ai/dsh-tool-frappe-docs'
  disabled: false
  config:
    knowledgeRoot: /home/zyd/frappe/frappe-docs-kb
    pythonExecutable: /usr/bin/python3
    timeoutMs: 30000
```

<a id="model-experience"></a>
## Model Experience

### Bundle composition

#### What the model sees

The Bundle itself contributes no prompt text. When enabled, the inserted package contributes its evidence-priority section and the three read-only schemas in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-frappe-docs).

#### Token effect

Zero while the Bundle row is disabled. When enabled, the inserted package contributes its fixed prompt section and tools.

#### KV Cache effect

Enabling or disabling the Bundle changes the mounted prompt and tool prefix. Index synchronization does not change the Bundle composition.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Deployment-owned synchronization** — the Bundle remains disabled until the local index exists and its absolute path is supplied by a deployment layer.
- **Read-only retrieval** — the inserted package cannot synchronize, edit, or publish official documentation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Bundle and deployment boundary are recorded in the [Frappe documentation knowledge-base Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-frappe-docs-knowledge-base.md).

</details>
