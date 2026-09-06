# Agent Note: Native Bench source evidence for the active Frappe runtime

Status: implemented

English | [中文](2026-08-27-native-bench-source-evidence.zh.md)

## Problem

Harness previously used its process workspace and generic filesystem tools when explaining Tongjianyun behavior. That workspace is not the active Frappe Bench, so source evidence could come from `/workspace`, an archived bench, or a deployment directory that no longer serves `child.myyr.top`. Database MCP calls also lacked a reliable source-of-truth pointer for interpreting the returned values.

## Decision

The `@deepseek-ai/dsh-tool-native-bench-source` package registers bounded, read-only tools for the configured Native Bench root. The deployment pins `/home/zyd/frappe/native-bench`, allows only its `apps/`, `sites/`, `config/`, `Procfile`, and `patches.txt`, and uses packaged ripgrep for source search. The package also exposes a credential-free runtime manifest with the default site, installed apps, and service ports. Its system-prompt section tells the model to search Native Bench source before using the permission-aware Tongjianyun nutrition tools and to report missing evidence instead of guessing.

The `@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules` package now defaults to a local read-only Frappe adapter. A bounded Python helper initializes the configured site in the active Bench, sets a deployment-owned fixed Frappe user, and imports only the three read operations from `tongjianyun.mcp_tools`. The TypeScript and Python layers both reject all other operations; no arbitrary SQL, Python callable, site path, or model-supplied user is accepted. The existing HTTP MCP transport remains available only when `transport: mcp` is explicitly selected, primarily for audited rule writes.

The `@deepseek-ai/dsh-tool-native-bench-frappe` package provides the corresponding generic Frappe platform bridge for every permitted DocType in the active Bench, including apps outside Tongjianyun. It exposes the installed-application and DocType catalog, safe field metadata, and structured list/get reads under the fixed deployment user's permissions. Existing business records also support a two-step scalar update: preview binds the document version and requested values, then apply requires standard Harness one-shot approval, rechecks the preview, and saves through the Frappe document lifecycle. The helper denies infrastructure, schema, and credential DocTypes, redacts sensitive fields, and never accepts SQL, Python, a site path, or a model-selected user. Its Bundle remains opt-in because the Bench path and site are deployment-owned settings.

The `@deepseek-ai/dsh-ione-native-bench-source` Bundle owns the opt-in patch entry. The production profile enables that entry with bounded limits. The nutrition package accepts reports generated under the Native Bench root while retaining the existing authenticated public download directory and database permission boundary.

Business-mode deployment uses an explicit expected user, a private signed actor assertion and a DocType allowlist. The adapter admits only describe/list/get reads, checks the signed actor against the expected user, and requires an enabled System User. Both process entry and client execution reject unsupported actions. This is a transport-level foundation: it does not provide shared-Web-session identity, class ownership, assertion renewal or isolation from other plugins. The focused Loader and Python policy tests cover these denials; a staff Web rollout remains gated on per-user session and capability isolation.

## Consequences

- Questions about nutrition calculations can combine exact source lines from `native-bench/apps` with current database rules and recipe data without a localhost or public MCP network hop.
- Questions about other Native Bench applications can combine the same source evidence with permission-aware Frappe ORM reads; the generic bridge is not limited to Tongjianyun.
- Source tools cannot read arbitrary host paths, secrets, logs, or database files, and they do not execute SQL or mutate Frappe. The generic Frappe bridge exposes only approved scalar updates to existing business records; create, delete, child-table, workflow, schema, SQL, and Python operations remain unavailable. The nutrition adapter is a separate read-only seam with a fixed operation allowlist; rule writes remain an explicit MCP/UI workflow.
- Deployments that move the active Bench must update one explicit `benchRoot` setting and restart Harness; the process working directory is no longer evidence of the application source.
- Historical source comparison still requires a release manifest or file hashes because app directories do not always carry a Git revision.

## Alternatives considered

- **Keep relying on `/workspace` and generic filesystem search** — rejected because it does not identify the running Bench and allowed stale or unrelated source to be presented as current evidence.
- **Add arbitrary SQL or Python access directly to the source package** — rejected because database permissions, validation, audit behavior, and business semantics belong to Frappe applications. The generic bridge uses structured metadata and ORM reads plus a preview/approved-document-save pair, while the nutrition adapter calls only its audited business functions.
- **Make the Native Bench package part of every default profile** — rejected because the package exposes deployment-specific host paths and must remain an explicit, auditable opt-in.
