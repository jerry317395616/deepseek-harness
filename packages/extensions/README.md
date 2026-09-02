---
description: "The extensions group map: model-facing tools and dual-half runners for defining, running, and removing dynamic Cordis packages, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/extensions

English | [中文](README.zh.md)

## Summary

The extensions group lets a running agent modify the runtime it runs inside: the model can inspect the plugins and services loaded in the current DSH process, define a dynamic Cordis package (with a host half, a browser half, or both), run it, stop it, and remove it, and a browser panel operates every definition. Packages evolve by plugin: a plugin holds immutable package versions and can run or update between them. Definitions live only in process memory, so a DSH restart clears them and nothing here writes repository files or configuration. Four packages form the subsystem: the model-facing tools plus the host runner, and the browser runner plus the browser UI.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | Model-facing runtime inspection and dynamic-package tools | registers on `ctx.tools` |
| [`tool-tongjianyun-nutrition-rules/`](tool-tongjianyun-nutrition-rules/README.md) | Local Native Bench Frappe read tools plus explicit authenticated MCP compatibility for the Tongjianyun nutrition-rule lifecycle | registers on `ctx.tools` |
| [`tool-native-bench-frappe/`](tool-native-bench-frappe/README.md) | Permission-aware, read-only Frappe ORM access for permitted DocTypes in the active Native Bench | registers on `ctx.tools` |
| [`tool-frappe-docs/`](tool-frappe-docs/README.md) | Version-aware retrieval over a locally synchronized official Frappe documentation index | registers on `ctx.tools` |
| [`cordis-host-runner/`](cordis-host-runner/README.md) | Definition registry, the `node:vm` sandbox for host halves, and the request-run round trip | provides `ctx.dynamicCordisRunner` |
| [`cordis-client-runner/`](cordis-client-runner/README.md) | Browser half of a dual-half package: evaluates the definition into a live browser plugin and answers the run request | client face; provides the browser `ctx.dynamicCordisRunner` |
| [`ui-cordis/`](ui-cordis/README.md) | Browser surfaces: the frame-wide panel that operates every definition, and the read-only define card | client face; registers slots |

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
