---
description: "Evaluate account-owned sessions in one shared Harness process without enabling employee agent execution."
---

# Shared employee session preview

English | [中文](employee-shared.zh.md)

## Summary

This opt-in overlay admits multiple verified Frappe accounts to one Harness process for session creation, listing and history paging. It is an API preview, not a shared chat interface or a production deployment. Employee prompt execution, tools, attachments, search and global event streams remain unavailable.

## Evaluate the preview

The [shared overlay](../../../apps/cli/config/examples/employee-shared/cordis.yml) follows the existing [read-only composition](employee-readonly.md) on a clean stock Web profile. The [real-process fixture](../../../apps/cli/tests/profiles/employee-readonly/employee-shared.expected.e2e.ts) supplies temporary directories and synthetic identities; it starts one Web process for two accounts and checks restart recovery. It does not read or mutate a live Frappe site.

Use Linux, Python 3.14 and a built checkout. `DSH_SHARED_IDENTITY_PYTHON` may select the test authority's interpreter; otherwise it uses `python3`.

```sh
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.expected.config.ts apps/cli/tests/profiles/employee-readonly/employee-shared.expected.e2e.ts
DSH_EXAMPLE_MODE=lib DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/employee-readonly.snapshot.ts
```

The recorded-session test uses a trusted Host test driver to seed the existing transcript, then checks account-owned history access. Employees cannot invoke that driver's prompt endpoint. Neither identity nor login credentials enter the model transcript; this overlay changes no model prompt, schema or event contract.

## Identity and session ownership

The [identity authority](../../../packages/extensions/tool-native-bench-frappe/python/shared_identity.py) is a separate trusted auxiliary process, not another Harness instance. It validates signed single-use Frappe handoffs and rechecks the current enabled System User through the existing Native Bench check-only helper. Its allowlist references existing per-account identity configurations. Unknown accounts are denied; this is not automatic admission of every site user.

The authority accepts only its configured runtime's kernel UID over a private Unix socket. Production configuration rejects root, the authority UID and the Bench-owner UID as runtime identities. The Harness process receives a verified `{site,user}` principal and opaque login cookie, never a signing key or Bench credential. A request cannot supply its own user or owner.

The [session API](../../../packages/api/session-controller/src/employee-access.ts) assigns a random session ID, publishes an immutable owner record before creation, and materializes that exact session before acknowledging it. Owner files live in a private canonical directory outside model logs. A failed creation can leave an owner reservation; listings return only existing owned sessions. Legacy sessions without ownership are denied rather than assigned to the next caller.

| Endpoint | Admitted behavior |
|---|---|
| `GET /employee/sso?token=…` | Exchange one signed handoff for a Secure, HttpOnly, SameSite=Strict cookie; redirect to status |
| `GET /employee/status` | Revalidate login and report `businessExecution: false` |
| `POST /employee/logout` | Revoke login and expire its cookie |
| `POST /employee/session/create` | Accept only `{}` and create a server-owned session |
| `POST /employee/session/list` | Accept only `{}` and return bounded metadata for this account |
| `POST /employee/session/page` | Read a bounded history page only after checking session ownership |

Host and write Origin must match the configured HTTPS origin. Duplicate cookies, unknown fields and unsupported operations are rejected. Authentication is repeated before releasing session results. Logout, account disablement, dependency failure or expiry denies later access; authority restart discards logins. Timeout, disconnect and plugin disposal abort and await owned request work, but cannot undo an already accepted session creation.

## Explicit configuration

The overlay reads `DSH_SHARED_PUBLIC_ORIGIN`, `DSH_SHARED_IDENTITY_SOCKET` and `DSH_SHARED_OWNERS_DIRECTORY`. Its source pins request, scan, response and deadline limits. The [plugin Config](../../../packages/api/session-controller/src/employee-access.ts) is the complete API contract; do not expose configuration or Host launch credentials to employees.

The authority runs with `--config` pointing to an operator-owned private JSON file. `--check` validates configuration without opening a listener. Accepted keys are exact:

| Field | Contract |
|---|---|
| `version`, `socket_path`, `runtime_uid` | Version 1, canonical protected Linux socket location, one distinct runtime UID |
| `issuer`, `secret_file`, `identity_configs` | Exact site, private signing-key file, 1–256 existing account-check configurations |
| `session_seconds`, `max_sessions` | 60–28800 seconds, 1–4096 simultaneous logins |
| `max_connections`, `timeout_seconds` | 1–64 connections, 1–30 seconds per operation |

## Before production admission

The existing Frappe launcher targets `/sso`; this preview uses `/employee/sso`. Production routing, a shared employee UI and real browser/TLS SSO acceptance are not installed by this change. Ordinary Host cookies still authorize privileged Host APIs; an employee cookie does not. Never distribute the Host launch URL to shared employees.

The UID-bound read broker still maps one UID to one employee. It cannot authorize different employees inside a shared process. Before enabling prompt execution, bind the verified session principal to each queued Agent turn, propagate it through a credential-free business bridge, and recheck Frappe role, record, field and workflow permissions for each operation. Never accept a model-selected actor or use an Administrator fallback.

Keep the shared runtime separate from Bench ownership and signing material, protect direct ports and every unscoped API, redact proxy ticket queries, and validate resource limits under load. This increment changes no Frappe DocType, business record, account permission or production service.

## Dev Note

The [decision note](../../../.agents/notes/implemented/architecture/2026-09-07-shared-session-ownership.md) records why this preview does not yet replace dedicated employee execution.
