# Agent Note: Employee login routing to dedicated Harness hosts

Status: implemented

English | [中文](2026-09-06-employee-login-routing.zh.md)

## Problem

The deployed Frappe launcher signs the employee identity, but a shared Harness launch credential does not distinguish session owners. Filtering a conversation list cannot authorize the runtime's other HTTP APIs, WebSocket traffic, settings or tools.

## Decision

The [employee gateway helper](../../../../packages/extensions/tool-native-bench-frappe/python/employee_gateway.py) routes a verified identity to a deployment-owned, single-employee upstream. It cannot select a fallback maintenance host, create runtimes or change Frappe records. Distinct private homes and launch credentials are required configuration, not a claim of operating-system isolation.

Login and replay state are bounded and process-local. A ticket is accepted once under a lock and must be issued after startup, so a restart invalidates earlier tickets and cookies without a new database schema. The optional traffic proxy authorizes each HTTP request and WebSocket upgrade, rechecks before releasing response data or relaying a data message, and monitors idle streams. Its account verifier invokes the existing Native Bench renewer in check-only mode. Logout, expiry and a failed identity check close both stream ends; shutdown awaits owned tasks.

## Alternatives considered

**Shared host with list filtering.** Session listings are only one entrypoint. This does not restrict tool execution, settings changes or direct API requests.

**Dynamically creating a runtime from login input.** Process paths, executable arguments and plugin composition are privileged deployment choices. Explicit pre-provisioned bindings keep them outside the handoff.

**Persisting authentication in new Frappe DocTypes.** The current project prohibits DocType changes. Short handoffs, bounded memory and post-start issuance provide fail-closed restart behavior without changing the application schema, at the cost of signing in again.

## Consequences

The source supplies and tests a routing component, not a deployed multi-user service. Production admission still requires isolated profiles, a verified deployment of the proxy, Frappe assertion issuance/renewal and disabled maintenance capabilities. The proxy uses aiohttp for framing and transport ownership rather than a custom WebSocket implementation. Revocation has explicit check/close deadlines and cannot undo accepted work. The [package README](../../../../packages/extensions/tool-native-bench-frappe/README.md#employee-login-routing-helper) owns the operating requirements.

The credential-free suite checks two identities through HTTP, concurrent replay, expiry, restart, logout and invalid bindings. The [recorded business denial](../../../../snapshots/session/native-frappe-business-denial/session.jsonl) verifies that a model cannot use the business reader to enumerate User records or apply updates; it does not test production login. The proxy transport suite covers bidirectional and idle revocation, in-flight HTTP rejection and cleanup. An opt-in fixture runs real employee Web processes and a recorded session through synthetic SSO identities. The site-pinned [live operator](../../../../scripts/employee-live-acceptance.py) additionally verifies actual Frappe handoff signatures, two-account tool permissions, replay rejection, cross-host session denial and logout/disable revocation through dedicated temporary hosts. Its local scripted model keeps record results off external providers. Exact disabled-account and roster admission plus an exclusive lock limit operational writes to the authorized test accounts; cleanup checks the accounts, sessions, business records and permissions. Public routing, browser/TLS behavior and production load remain separate acceptance requirements.
