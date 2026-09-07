# Agent Note: Explicit single-user identity policy

Status: implemented

English | [中文](2026-09-07-single-user-identity.zh.md)

## Problem

The deployment owner requires one non-root Linux account for Bench and one shared Harness. Distinct runtime ownership cannot describe that deployment, but removing UID checks silently would obscure the security boundary.

## Decision

The shared identity authority accepts an optional `uid_policy`. Its default is `separate`. Explicit `single-user` requires the runtime UID, authority effective UID and every configured Bench owner to match a non-root account. Kernel peer checks, signed login validation, pinned per-account reads and read-only scope remain mandatory. The [guide](../../../../docs/user/guide/employee-shared.md) owns the configuration contract.

This deployment option supplements the [account-owned preview](2026-09-07-shared-session-ownership.md); it does not expose employee prompt execution. The protocol keeps secrets out of responses, but a shared UID cannot prevent unrestricted local code from reading the same private files.

## Alternatives considered

**Remove ownership validation.** This would silently weaken existing deployments and admit mixed ownership without a deliberate operator choice.

**Require another Linux account.** This provides a stronger OS boundary but conflicts with the requested deployment. Separate mode remains the default for operators who require that boundary.

## Consequences

Configuration tests cover explicit admission, default separation, mismatched authority and Bench ownership, root rejection and invalid policy values. Existing account, revocation, actor-forgery and denied-write tests continue to exercise the unchanged request path. This option cannot make arbitrary shell or filesystem tools safe for employees; production routing and per-turn Agent identity binding remain outside this change. No production configuration or Frappe DocType changes are included.
