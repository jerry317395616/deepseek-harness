# Agent Note: Request-owned employee Agent turns

Status: implemented

English | [中文](2026-09-07-employee-authenticated-turns.zh.md)

## Problem

Account-owned session history does not bind an execution identity. Host prompt receipts acknowledge queue admission, and the fixed-account Frappe client cannot distinguish employees sharing one runtime UID.

## Decision

The [employee API](../../../../packages/api/session-controller/src/employee-access.ts) optionally accepts text prompts under a deployment-owned read-only preset. Its [turn executor](../../../../packages/api/session-controller/src/employee-turns.ts) reserves one request per session, assigns a server-generated message correlation ID and retains the verified principal and opaque login outside the transcript. The first admitted message binds one numbered turn and Agent; unrelated queue or steering input cannot inherit its authority. The request waits through whole-Agent idle and retains no credentials after cleanup. Restart cannot resume authorization.

Every model request and read revalidates the same account. The scoped read tool enforces the bound Agent in its body and calls the shared authority rather than the UID-bound client. A monotonic guard denies other tools and actorless calls. Tool calls and results use existing session events; no event format or Frappe schema changes are required. Logout cancels matching activities. Disconnect, deadline and disposal cancel and await local work; an accepted remote read remains bounded by the authority's independent deadline.

## Alternatives considered

**Use a deployment-global Frappe user.** That would return another employee's records when two logins overlap. The authority resolves each opaque login independently and Frappe remains responsible for document permissions.

**Keep authorization until a session ends.** Sessions survive logout and process restart. Request-owned credentials expire with the active HTTP operation and cannot authorize replayed inbox messages.

**Expose the ordinary Host prompt API.** Its queue acknowledgement does not prove an employee identity or per-message completion. The separate endpoint owns admission through quiescence and rejects overlapping requests rather than attributing a shared running interval to multiple users.

## Consequences

The [process tests](../../../../apps/cli/tests/profiles/employee-readonly/employee-turns.expected.e2e.ts) verify two scoped identities, concurrent active accounts, overlap denial, cancellation, logout and reuse after settlement. [Unit tests](../../../../packages/api/session-controller/tests/employee-turns.host.spec.ts) exercise unrelated turn rejection, pre-model disablement, direct tool-body denial and post-read revocation. The [recorded session](../../../../snapshots/web/employee-shared-readonly/session.jsonl) pins the authenticated query and permission-scoped result. Tests substitute model output and business data, not the Agent or tool runtime in process scenarios.

This extends the [ownership preview](2026-09-07-shared-session-ownership.md), not its production deployment. Real browser SSO, shared chat UI, live-site permission acceptance and load testing remain absent. The response reports settlement and a history cursor, not business success. Business writes, arbitrary code, schema changes, attachments and global employee event streams remain unavailable. The one-UID deployment retains application-level separation, not isolation from unrestricted code running as that UID.
