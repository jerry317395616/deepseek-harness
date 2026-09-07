# Agent Note: Account-owned sessions in one Harness process

Status: implemented

English | [中文](2026-09-07-shared-session-ownership.zh.md)

## Problem

The user requests one shared Harness rather than one process per employee. A Host launch cookie is not a Frappe principal, and the existing read broker's UID binding cannot distinguish callers in a shared process. Reusing either credential for all employees would erase their authorization boundary.

## Decision

Add an explicit session-only preview: a trusted Unix-socket authority verifies signed handoffs and current enabled accounts, while the Session Controller subpath assigns immutable `{site,user}` ownership outside model logs. Creation persists the exact session before success; list and page verify ownership and recheck login before returning data. Missing ownership, malformed input and authority failure deny access.

Employee credentials authorize only this API. The ordinary Host API and global event stream retain Host authentication. No employee prompt endpoint is exposed until queued Agent work and business execution can preserve the verified caller. A disabled account check is not a substitute for Frappe business permissions.

## Alternatives considered

**Shared administrator execution with role text in a prompt.** Model instructions cannot enforce document, field or workflow permissions. Caller identity must come from authentication and remain fixed through execution.

**Change all remote APIs and UI at once.** That would expose execution before the per-call identity bridge exists. The closed preview permits falsifiable two-account tests without publishing an incomplete employee entry.

**Rename or add Frappe DocTypes for session ownership.** The project prohibits schema changes. Private append-only ownership records provide restart recovery without touching application structure or business records.

## Consequences

The focused HTTP/ownership suite covers both accounts, forged ownership, unowned legacy sessions, immutable files, response limits, timeout, client disconnect and disposal. Python tests exercise replay races, logout during revalidation, disabled accounts, expiry, restart and real socket teardown. The real-process fixture admits two accounts to one Web process; the existing recorded-session replay verifies owned history without changing model-visible contracts.

The [guide](../../../../docs/user/guide/employee-shared.md) owns configuration and acceptance boundaries. Shared employee UI, production SSO routing, per-turn caller binding, authorized business execution and browser/load acceptance remain pending. No production route, service, Frappe account, record or DocType changed.

## Supersession audit

The [dedicated-host decision](2026-09-06-employee-login-routing.md) is only partially superseded: this preview starts the shared deployment direction, but does not replace its supported employee execution path. Keep that note active and cross-link the new scope; archive no triplet until shared execution and deployment requirements replace the older contract.
