# Agent Note: Tongjianyun nutrition-rule plugin

Status: implemented

English | [中文](2026-08-22-tongjianyun-nutrition-rule-plugin.zh.md)

## Problem

The Tongjianyun weekly-menu nutrition calculation workflow needed to be available as a normal Harness plugin rather than as an IONE Agent-only Skill. Model calls must preserve the Frappe backend's draft, preview, review, publish, rollback, role, audit, and confirmation controls without revealing API credentials or user assertions.

## Decision

`@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules` registers eight native tools on `ctx.tools` and sends standard JSON-RPC `tools/call` requests to the authenticated Frappe MCP method. Two read-only evidence tools explain the roster-weighted or manually selected full-day reference calculation and analyze a real weekly recipe; six tools retain the controlled rule lifecycle. A fixed `ctx.systemPrompt` section routes Tongjianyun standards and actual-recipe questions to those evidence tools before the model answers. It resolves a Frappe integration credential and optional current-user assertion from `ctx.credentials` immediately before each call. The `@deepseek-ai/dsh-ione-tongjianyun-nutrition-rules` Bundle inserts the tool row disabled, leaving each deployment to enable it with its endpoint and credential references.

The two irreversible operations require exact Chinese confirmations in both the tool body and Frappe. The server remains the authority for permission checks, audit logging, rule-state transitions, and the same confirmation text.

## Alternatives considered

**Retain only the IONE Agent Skill** — rejected. It is not discoverable or composable as a Harness plugin and cannot participate in the normal tool registry, Loader lifecycle, Bundle configuration, or formal plugin inventory.

**Use the generic MCP client package** — rejected. The Tongjianyun method has a Frappe-specific JSON-RPC envelope and needs per-call credentials plus an optional hidden current-user assertion. A generic endpoint declaration would not establish those domain controls.

## Consequences

The nutrition lifecycle and evidence path are visible to the model as eight bounded native schemas, can be installed through normal Harness Bundle composition, and unload cleanly with its Loader fiber. The routing section prevents workspace-source search from being mistaken for Tongjianyun evidence. Credential values remain in the credential provider and never appear in tool schemas, prompts, results, or configuration patches.

Deployments that require a Frappe actor token need a trusted identity bridge that refreshes the `actorTokenRef` value for the active Harness user. A static long-lived actor token is intentionally unsupported.

## Verification

The real Loader-composition test mounts `dsh-tools`, `dsh-system-prompt`, `dsh-credentials-local`, and the nutrition plugin from a temporary cordis.yml. It snapshots the eight tool registrations and routing text, proves every call maps to its Frappe MCP tool, keeps credentials and actor assertions request-only, rejects invalid destructive confirmations before transport, and proves Loader disposal removes both tools and routing guidance.
