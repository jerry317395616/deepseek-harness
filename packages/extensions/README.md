---
description: "The extensions group map: model-facing tools and dual-half runners for defining, running, and removing dynamic Cordis packages, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/extensions

English | [中文](README.zh.md)

## Summary

The extensions group lets an agent inspect and modify the live DSH runtime without editing repository files or configuration. It can define, run, update, stop, and remove dynamic Cordis packages from model tools or a browser panel. A package may affect the host, browser, or both, and immutable versions support controlled updates. Definitions exist only in process memory and disappear when DSH restarts. Choose the child package for model tooling, host execution, browser execution, or browser controls.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-cordis`](tool-cordis/README.md) | Seven model-facing tools: inspect the live runtime, define, run, stop, and remove dynamic packages | registers on `ctx.tools` |
| [`cordis-host-runner`](cordis-host-runner/README.md) | Host half: definition registry, sandboxed host-half lifecycle, and the inspect registry that answers browser queries | provides `ctx.dynamicCordisRunner` and `ctx.cordisInspect` |
| [`cordis-client-runner`](cordis-client-runner/README.md) | Browser half: evaluates a browser-half source into a live plugin and answers run requests | client face; provides browser `ctx.dynamicCordisRunner` |
| [`ui-cordis`](ui-cordis/README.md) | Browser surfaces: the frame-wide panel, lifecycle tool cards, and the `@pluginId` input source | client face; registers slots |
| [`tool-tongjianyun-nutrition-rules/`](tool-tongjianyun-nutrition-rules/README.md) | Local Native Bench Frappe read tools plus explicit authenticated MCP compatibility for the Tongjianyun nutrition-rule lifecycle | registers on `ctx.tools` |
| [`tool-native-bench-frappe/`](tool-native-bench-frappe/README.md) | Permission-aware, read-only Frappe ORM access for permitted DocTypes in the active Native Bench | registers on `ctx.tools` |
| [`tool-frappe-docs/`](tool-frappe-docs/README.md) | Version-aware retrieval over a locally synchronized official Frappe documentation index | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

The [extensions subsystem page](../../docs/subsystems/extensions.md) explains the shared lifecycle, ownership boundaries, and runtime surfaces for this package group.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The synchronized official-documentation retrieval boundary is recorded in the [Frappe documentation knowledge-base Agent Note](../../.agents/notes/implemented/architecture/2026-09-02-frappe-docs-knowledge-base.md).

</details>
