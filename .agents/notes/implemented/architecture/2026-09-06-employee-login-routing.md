# Agent Note: Employee login routing to dedicated Harness hosts

Status: implemented

English | [中文](2026-09-06-employee-login-routing.zh.md)

## Problem

The deployed Frappe launcher signs the employee identity, but a shared Harness launch credential does not distinguish session owners. Filtering a conversation list cannot authorize the runtime's other HTTP APIs, WebSocket traffic, settings or tools.

## Decision

The [employee gateway helper](../../../../packages/extensions/tool-native-bench-frappe/python/employee_gateway.py) routes a verified identity to a deployment-owned, single-employee upstream. It cannot select a fallback maintenance host, create runtimes or change Frappe records. Distinct private homes and launch credentials are required configuration, not a claim of operating-system isolation.

Login and replay state are bounded and process-local. A ticket is accepted once under a lock and must be issued after startup, so a restart invalidates earlier tickets and cookies without a new database schema. The proxy must authorize each HTTP request and WebSocket upgrade; existing streams require separate revocation.

## Alternatives considered

**Shared host with list filtering.** Session listings are only one entrypoint. This does not restrict tool execution, settings changes or direct API requests.

**Dynamically creating a runtime from login input.** Process paths, executable arguments and plugin composition are privileged deployment choices. Explicit pre-provisioned bindings keep them outside the handoff.

**Persisting authentication in new Frappe DocTypes.** The current project prohibits DocType changes. Short handoffs, bounded memory and post-start issuance provide fail-closed restart behavior without changing the application schema, at the cost of signing in again.

## Consequences

The source supplies and tests a routing component, not a deployed multi-user service. Production admission still requires isolated profiles, a verified proxy, Frappe assertion issuance/renewal, disabled maintenance capabilities and active-stream revocation. The [package README](../../../../packages/extensions/tool-native-bench-frappe/README.md#employee-login-routing-helper) owns the operating requirements.

The credential-free suite checks two identities through HTTP, concurrent replay, expiry, restart, logout and invalid bindings. The [recorded business denial](../../../../snapshots/session/native-frappe-business-denial/session.jsonl) verifies that a model cannot use the business reader to enumerate User records or apply updates; it does not test production login.
