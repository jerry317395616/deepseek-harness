# Agent Note: Account-owned sessions in one Harness process

Status: implemented

English | [中文](2026-09-07-shared-session-ownership.zh.md)

## Problem

The user requests one shared Harness rather than one process per employee. A Host launch cookie is not a Frappe principal, and the existing read broker's UID binding cannot distinguish callers in a shared process. Reusing either credential for all employees would erase their authorization boundary.

## Decision

Use an explicit account-owned API preview: a trusted Unix-socket authority verifies signed handoffs and current enabled accounts, while the Session Controller subpath assigns immutable `{site,user}` ownership outside model logs. Creation persists the exact session before success; list, page and scoped reads verify ownership and recheck login before returning data. Missing ownership, malformed input and authority failure deny access.

Employee credentials authorize only this API. The ordinary Host API and global event stream retain Host authentication. Optional [request-owned turns](2026-09-07-employee-authenticated-turns.md) preserve the verified caller through read-only execution; omission of the preset keeps execution blocked. A disabled account check is not a substitute for Frappe business permissions.

For read requests, the authority selects the existing pinned account configuration from the resolved login, then reuses the native reader's signed identity and ORM permission checks. The shared UID admits the runtime process but never selects the employee. Explicit scope, strict arguments, one active read per account and bounded replies limit this API. Post-read login revalidation prevents logout, disablement or expiry from releasing in-flight results; replacement logins do not revive old requests.

## Alternatives considered

**Use a Host prompt to execute an employee session.** Host authentication does not bind a Frappe account to queued work. Owned execution requires a request-owned authenticated turn; otherwise steps, requests and tool calls are denied. Ownership is indexed before session creation and restored before admission; failed reservations remain blocked. The dedicated persona recording uses a separate unowned Host session; the shared recording uses the employee API.

**Shared administrator execution with role text in a prompt.** Model instructions cannot enforce document, field or workflow permissions. Caller identity must come from authentication and remain fixed through execution.

**Change all remote APIs and UI at once.** That would expose execution before the per-call identity bridge exists. The closed preview permits falsifiable two-account tests without publishing an incomplete employee entry.

**Rename or add Frappe DocTypes for session ownership.** The project prohibits schema changes. Private append-only ownership records provide restart recovery without touching application structure or business records.

## Consequences

The focused HTTP/ownership suite covers both accounts, forged ownership, unowned legacy sessions, immutable files, response limits, timeout, client disconnect and disposal. Python tests exercise replay races, logout during revalidation, disabled accounts, expiry, restart and real socket teardown. The real-process fixture admits two accounts to one Web process; the existing recorded-session replay verifies owned history without changing model-visible contracts.

The [guide](../../../../docs/user/guide/employee-shared.md) owns configuration and acceptance boundaries. The read tests exercise concurrent accounts, actor forgery, scoped denial, revocation during reads, cancellation and the shared runtime's restart. Business results in these fixtures are synthetic; the native adapter reuses the existing signed-reader tests, not live site acceptance. Shared employee UI, production SSO routing and browser/live-site/load acceptance remain pending. No production route, service, Frappe account, record or DocType changed.

## Supersession audit

The [dedicated-host decision](2026-09-06-employee-login-routing.md) is only partially superseded: this preview starts the shared deployment direction, but does not replace its supported employee execution path. Keep that note active and cross-link the new scope; archive no triplet until shared execution and deployment requirements replace the older contract.
