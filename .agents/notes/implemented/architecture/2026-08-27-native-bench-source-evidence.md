# Agent Note: Native Bench source evidence for the active Frappe runtime

Status: implemented

English | [中文](2026-08-27-native-bench-source-evidence.zh.md)

## Problem

Harness previously used its process workspace and generic filesystem tools when explaining Tongjianyun behavior. That workspace is not the active Frappe Bench, so source evidence could come from `/workspace`, an archived bench, or a deployment directory that no longer serves `child.myyr.top`. Database MCP calls also lacked a reliable source-of-truth pointer for interpreting the returned values.

## Decision

The `@deepseek-ai/dsh-tool-native-bench-source` package registers bounded, read-only tools for the configured Native Bench root. The deployment pins `/home/zyd/frappe/native-bench`, allows only its `apps/`, `sites/`, `config/`, `Procfile`, and `patches.txt`, and uses packaged ripgrep for source search. The package also exposes a credential-free runtime manifest with the default site, installed apps, and service ports. Its system-prompt section tells the model to search Native Bench source before using the permission-aware Tongjianyun nutrition MCP tools and to report missing evidence instead of guessing.

The `@deepseek-ai/dsh-ione-native-bench-source` Bundle owns the opt-in patch entry. The production profile enables that entry with bounded limits. The nutrition package accepts reports generated under the Native Bench root while retaining the existing authenticated public download directory and database permission boundary.

## Consequences

- Questions about nutrition calculations can combine exact source lines from `native-bench/apps` with current database rules and recipe data.
- Source tools cannot read arbitrary host paths, secrets, logs, or database files, and they do not execute SQL or mutate Frappe.
- Deployments that move the active Bench must update one explicit `benchRoot` setting and restart Harness; the process working directory is no longer evidence of the application source.
- Historical source comparison still requires a release manifest or file hashes because app directories do not always carry a Git revision.

## Alternatives considered

- **Keep relying on `/workspace` and generic filesystem search** — rejected because it does not identify the running Bench and allowed stale or unrelated source to be presented as current evidence.
- **Add SQL access directly to the source package** — rejected because database permissions, audit behavior, and nutrition rule semantics already belong to the authenticated Tongjianyun Frappe MCP package.
- **Make the Native Bench package part of every default profile** — rejected because the package exposes deployment-specific host paths and must remain an explicit, auditable opt-in.
