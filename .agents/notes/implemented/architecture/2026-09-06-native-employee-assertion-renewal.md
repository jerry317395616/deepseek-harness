# Agent Note: Native Bench employee assertion renewal

Status: implemented

English | [中文](2026-09-06-native-employee-assertion-renewal.zh.md)

## Problem

Employee business reads require a short-lived, pinned identity. A Docker-bound renewal script that rewrites one shared model credential cannot supply independent assertions to Native Bench employee runtimes. Repairing only its directory would preserve the shared integration identity.

## Decision

The [deployment renewer](../../../../packages/extensions/tool-native-bench-frappe/python/native_actor_refresh.py) loads one private configuration, reads one exact enabled System User through Frappe ORM, and issues an assertion compatible with the installed I-ONE verifier. It verifies the result before publishing it to one private destination. Signing material and assertions remain inside the deployment process and owner-only files, not model arguments, stdout or stderr.

Atomic publication lets an existing reader finish its complete old file while later readers receive the complete replacement. A renewal failure after opening a validated destination removes the earlier assertion. Configuration/open failures and forced termination remain bounded by the previous expiry. The scheduler owns serialization and lifecycle; deleting a binding requires stopping its renewal and handling its outstanding file.

This is a privileged deployment operation, not a Cordis tool, remote endpoint or employee login. It does not create accounts, modify roles, save business records or alter DocTypes. The [login routing decision](2026-09-06-employee-login-routing.md) still requires isolated hosts and verified proxy authorization.

## Alternatives considered

**Repairing the legacy Docker command.** Native Bench is the active deployment, and the legacy command renews a shared integration identity rather than one employee.

**Putting signing material in each employee host.** A compromised employee process could mint another identity. The issuer must remain outside employee-controlled processes and configuration.

**Retaining a valid assertion after a known renewal failure.** This would preserve access after the issuer has observed an unavailable account or failed verification. Removing the validated old file closes that interval; an unavailable issuer process is still bounded by expiry and the reader's live account check.

## Consequences

The helper supports source-managed renewal without a new data model. It adds a privileged process that deployment must isolate, schedule and monitor. POSIX private files alone do not isolate processes sharing an operating-system identity, and the helper does not authorize Web sessions or revoke active streams.

Credential-free tests cover identity pinning, expiry contents, verification refusal, private atomic publication, revocation, redacted CLI failure and native-context cleanup. A real-site check is additionally required to establish compatibility with the installed I-ONE verifier; those unit tests do not replace employee login or host-isolation testing. The helper changes no model schemas or session events, so its CLI expectations remain owner-local; the existing recorded business-denial scenario supplies reader regression coverage.
