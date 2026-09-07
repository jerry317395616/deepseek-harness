---
description: "Evaluate account-owned sessions and authenticated read-only Agent turns in one shared Harness process."
---

# Shared employee session preview

English | [中文](employee-shared.zh.md)

## Summary

This opt-in overlay admits multiple verified Frappe accounts to one Harness process for owned sessions, scoped Frappe reads and authenticated read-only Agent turns. It is an API preview, not a shared chat interface or a production deployment. Attachments, search, business writes and global event streams remain unavailable.

## Evaluate the preview

The [shared overlay](../../../apps/cli/config/examples/employee-shared/cordis.yml) follows the existing [read-only composition](employee-readonly.md) on a clean stock Web profile. The [real-process fixture](../../../apps/cli/tests/profiles/employee-readonly/employee-shared.expected.e2e.ts) supplies temporary directories and synthetic identities; it starts one Web process for two accounts and checks restart recovery. It does not read or mutate a live Frappe site.

Use Linux, Python 3.14 and a built checkout. `DSH_SHARED_IDENTITY_PYTHON` may select the test authority's interpreter; otherwise it uses `python3`.

```sh
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.expected.config.ts apps/cli/tests/profiles/employee-readonly/employee-shared.expected.e2e.ts
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.expected.config.ts apps/cli/tests/profiles/employee-readonly/employee-turns.expected.e2e.ts
DSH_EXAMPLE_MODE=lib DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/employee-shared.snapshot.ts
```

The recorded-session test submits text through the employee API and records the permission-scoped tool result. The process tests also verify that a Host prompt cannot start an unbound employee turn. Employees cannot invoke the Host prompt endpoint. Neither identity nor login credentials enter the model transcript; the shared preset exposes only `employee_frappe_read`.

## Identity and session ownership

The [identity authority](../../../packages/extensions/tool-native-bench-frappe/python/shared_identity.py) is a separate trusted auxiliary process, not another Harness instance. It validates signed single-use Frappe handoffs and rechecks the current enabled System User through the existing Native Bench check-only helper. Its allowlist references existing per-account identity configurations. Unknown accounts are denied; this is not automatic admission of every site user.

The authority accepts only its configured runtime's kernel UID over a private Unix socket. The default `separate` UID policy rejects root, the authority UID and the Bench-owner UID as runtime identities. Explicit `single-user` policy requires one non-root UID for the runtime, authority and every Bench owner. The protocol returns a verified `{site,user}` principal and opaque login cookie, not signing keys or Bench credentials. A request cannot supply its own user or owner.

Single-user mode is application-level account separation, not OS isolation: any unrestricted process running as that UID can access the same private files. Do not give employees shell, arbitrary file access, configuration editing or Host credentials. This option does not authorize employee Agent execution or business writes.

The [session API](../../../packages/api/session-controller/src/employee-access.ts) assigns a random session ID, publishes an immutable owner record before creation, and materializes that exact session before acknowledging it. Owner files live in a private canonical directory outside model logs. A failed creation can leave an owner reservation; listings return only existing owned sessions. Legacy sessions without ownership are denied rather than assigned to the next caller.

Without `promptPreset`, the API blocks all employee Agent execution. With that explicit preset, only a server-identified message admitted through the employee prompt endpoint can enter a turn. Startup loads the bounded ownership index before mounting routes; new reservations enter the index before asynchronous publication. Operators must not edit ownership files while the service runs. Unowned Host sessions retain their existing execution policy; employee cookies cannot access them.

| Endpoint | Admitted behavior |
|---|---|
| `GET /employee/sso?token=…` | Exchange one signed handoff for a Secure, HttpOnly, SameSite=Strict cookie; redirect to status |
| `GET /employee/status` | Revalidate login; report `read-only-turns` with execution enabled when `promptPreset` is set, otherwise `read-preview` with execution disabled |
| `POST /employee/logout` | Revoke login and expire its cookie |
| `POST /employee/session/create` | Accept only `{}` and create a server-owned session |
| `POST /employee/session/list` | Accept only `{}` and return bounded metadata for this account |
| `POST /employee/session/page` | Read a bounded history page only after checking session ownership |
| `POST /employee/session/read` | Accept `sessionId`, a permitted read `operation` and structured `arguments`; require session ownership and current Frappe permissions |
| `POST /employee/session/prompt` | With `promptPreset`, accept only `sessionId` and `text`; wait for settlement and return `throughSeq` for owned history paging |

Host and write Origin must match the configured HTTPS origin. Duplicate cookies, unknown fields and unsupported operations are rejected. Authentication is repeated before releasing results. Logout, account disablement, dependency failure or expiry denies later access; authority restart discards logins. Timeout, disconnect and plugin disposal abort and await local request work, but cannot undo accepted session creation or cancel an accepted remote read immediately. Remote reads have the authority deadline; shutdown cancels and awaits its workers.

The read endpoint accepts only `frappe_describe_doctype`, `frappe_list_documents` and `frappe_get_document`. The authority resolves the opaque login to its pinned account configuration, validates the explicit DocType scope and invokes the existing business reader with that account's private assertion. It does not authorize by the shared runtime UID or accept user, site, executable, permission-bypass or write arguments. The existing reader checks the signed account and uses Frappe permissions and `get_list`; this layer adds no class-access policy of its own.

An authenticated turn retains its opaque login only in request memory. Before each model request and around each read, the executor verifies the same enabled account. Only the admitted message may start its numbered turn; another queued or steering message cannot inherit that authority. Each session admits one active prompt. Logout cancels its active prompts; disconnect and timeout cancel and join the Agent. Restart restores ownership but never execution credentials. A fresh login can submit a new turn, not revive old work. `settled` means the activity ended, not that a business operation succeeded; inspect its history using the returned `throughSeq`.

The scoped `employee_frappe_read` tool uses the same three authority operations and records ordinary tool calls and results. Its body checks the bound Agent and revalidates the login; a monotonic guard rejects other tools and actorless execution. The deployment-owned shared preset has no shell, files, subagents or fixed-account Frappe client. Requests cannot select a preset, user, site or execution mode. Authority reads remain independently deadline-bound; local cancellation does not promise immediate termination of an already accepted remote read.

Only one read per account runs at a time. Queries remain bounded to 8192 wire bytes and replies to 262144 bytes, with any smaller API response limit also applied. Revocation during a read discards the result; a new login cannot revive the old request. Results return to the authenticated API caller and are not appended to model history. This endpoint is not an Agent tool or an audit-complete AI execution path.

## Explicit configuration

The overlay reads `DSH_SHARED_PUBLIC_ORIGIN`, `DSH_SHARED_IDENTITY_SOCKET`, `DSH_SHARED_OWNERS_DIRECTORY` and `DSH_SHARED_PRESET_ROOT`. The last points to the overlay's `presets` directory; `promptPreset` selects `employee-shared-readonly`. Its source pins request, scan, response and deadline limits. The [plugin Config](../../../packages/api/session-controller/src/employee-access.ts) is the complete API contract; do not expose configuration or Host launch credentials to employees.

The authority runs with `--config` pointing to an operator-owned private JSON file. `--check` validates configuration without opening a listener. Accepted keys are exact:

| Field | Contract |
|---|---|
| `version`, `socket_path`, `runtime_uid` | Version 1, canonical protected Linux socket location, one non-root runtime UID |
| `uid_policy` | Optional `separate` (default) or explicit `single-user`; mixed ownership is rejected in single-user mode |
| `issuer`, `secret_file`, `identity_configs` | Exact site, private signing-key file, 1–256 existing account-check configurations |
| `session_seconds`, `max_sessions` | 60–28800 seconds, 1–4096 simultaneous logins |
| `max_connections`, `timeout_seconds` | 1–64 connections, 1–30 seconds per operation |
| `read_doctypes` | Required list of 0–64 distinct safe DocTypes; an empty list disables all business reads |

Read access also requires an existing valid assertion for each account. The trusted deployment owns [assertion renewal](../../../packages/extensions/tool-native-bench-frappe/README.md#native-bench-assertion-renewal); the shared API exposes neither renewal nor assertion files. Single-user mode cannot protect these files against unrestricted code under the same UID. Missing or expired assertions fail closed. The keyless fixture substitutes only account state and business query results; live Frappe permission and browser acceptance remain deployment work.

## Before production admission

The existing Frappe launcher targets `/sso`; this preview uses `/employee/sso`. Production routing, a shared employee UI and real browser/TLS SSO acceptance are not installed by this change. Ordinary Host cookies still authorize privileged Host APIs; an employee cookie does not. Never distribute the Host launch URL to shared employees.

The UID-bound read broker still maps one UID to one employee. It cannot authorize different employees inside a shared process. The shared authority selects the account independently for each read. The authenticated API needs real browser/TLS SSO and live-site acceptance before employee rollout. Writes require their own business services, workflow checks and approvals. Never accept a model-selected actor or use an Administrator fallback.

Use separate UIDs when OS isolation from Bench ownership and signing material is required. Under either policy, protect direct ports and every unscoped API, redact proxy ticket queries, and validate resource limits under load. This preview changes no Frappe DocType, business record, account permission or production service.

## Dev Note

The [ownership decision](../../../.agents/notes/implemented/architecture/2026-09-07-shared-session-ownership.md) and [request-owned turns](../../../.agents/notes/implemented/architecture/2026-09-07-employee-authenticated-turns.md) record the shared API's authorization and deployment limits.
