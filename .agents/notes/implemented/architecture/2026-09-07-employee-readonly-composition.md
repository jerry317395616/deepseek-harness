# Agent Note: Employee read-only Web composition

Status: implemented

English | [中文](2026-09-07-employee-readonly-composition.zh.md)

## Problem

A business-only model adapter does not constrain the stock Web profile's coding presets, Host RPCs, or shared persistence. A deployment needs an explicit composition whose model capabilities and Remote surface can be checked together.

## Decision

Ship an opt-in [employee overlay](../../../../apps/cli/config/examples/employee-readonly/cordis.yml) and operator-owned adjacent preset. The overlay excludes shipped and user preset roots, disables coding and authoring providers, and uses an exact Gateway endpoint list. The preset supplies a complete read-only business persona and only the Native Bench Frappe business reader. No ordinary Web default changes.

Each employee deployment owns a separate process, workspace, state roots, browser credential, and signed Frappe identity. Document access remains subject to the adapter's existing signed-identity and Frappe permission checks. The overlay is trusted code and must not be combined with unreviewed maintenance patches.

An optional [Linux read broker](../../../../packages/extensions/tool-native-bench-frappe/python/employee_read_broker.py) provides the trusted backend for UID-pinned reads. It rejects caller-selected identity and write operations, delegates record permissions to the existing reader, and checks account status before returning data. It is not mounted by the overlay or wired into the client; OS provisioning and credential isolation remain independent requirements.

## Alternatives considered

**Use the stock standard preset with fewer buttons.** Model tools and direct Remote calls retain authority independently of browser presentation.

**Disable all presets.** Agent composition can then inherit the global layer; a fixed closed preset root makes the intended tool owner explicit.

**Claim complete multi-user isolation.** Private process state does not isolate same-UID filesystem access, perform employee SSO, or revoke active sockets.

## Consequences

The shipped artifact is an API-tested preview. It does not activate production services, create a DocType, modify business records, or grant employee roles. Stock UI controls can remain visible while their operations are denied. Live browser, proxy, model-data, and real-account authorization acceptance remain deployment responsibilities.

The endpoint list and explicit disabled rows must be reviewed against stock composition changes. The full model prompt and tool roster are pinned by a recorded-session fixture, which detects accidental capability or persona expansion.

## Verification

A real built CLI test starts two private Web processes with only the model provider mocked. It rejects HTTP and WebSocket mutators, alternate presets, a model-emitted shell call, foreign credentials, and foreign session reads. It checks missing filesystem effects and reloads the durable session in a fresh process; the existing resume seed marker is permitted while prior records stay byte-identical.

The keyless Web recorded-session owner replays its own transcript through the same CLI overlay and compares the persisted session, complete prompt, and tool schemas. Tests use synthetic identities and no production data. They prove application composition, not a live employee login or an operating-system sandbox.
