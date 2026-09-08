# Agent Note: Application-owned preview and human confirmation

Status: implemented

English | [中文](2026-09-08-application-preview-confirmation.zh.md)

## Problem

Shared authenticated turns can read business records but have no way to prepare an application-owned change without duplicating session authentication in another plugin.

## Decision

The opt-in employee transport forwards bounded application requests under the verified login and immutable session owner. The model receives `employee_application_preview` only after capability admission. A separate same-origin browser confirmation route accepts the displayed preview identifier and digest, never replacement business values. Application code outside Harness owns business rules, durable preview storage, expiry, idempotence and audit transactions. Cookies never enter model messages or persisted session events.

## Alternatives considered

**A write operation inside the read tool** misrepresents effects and lets the model bypass independent human confirmation.

**A second application-specific session controller** duplicates ownership, cancellation and private credential handling. The generic transport keeps those responsibilities with their existing owner.

## Consequences

Deployments must opt in and implement the authority protocol; existing read deployments do not gain writes. Confirmation disconnects cannot imply rollback. Clients must inspect authoritative receipts and must not reconstruct approval from assistant text. The recorded Web scenario verifies preview persistence and separate browser confirmation through a real CLI-loaded process; unit tests cover actor/session overrides, cross-origin calls, closed configuration and disposal. Application-side business transactions and crash recovery remain the application's test responsibility.
