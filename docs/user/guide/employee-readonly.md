---
description: "Evaluate an isolated read-only Frappe employee conversation through the opt-in Web composition."
---

# Employee read-only preview

English | [中文](employee-readonly.zh.md)

## Summary

The employee read-only overlay lets an operator evaluate a Frappe business conversation without coding tools. Each employee needs a separate Web process, private state directories, and a deployment-fixed signed Frappe identity. The model can describe allowed document types, query lists, and read records. This is an API-tested deployment preview, not a multi-user server or a completed employee login interface.

## Table of Contents

- [Evaluate the preview](#evaluate-the-preview)
- [Deployment requirements](#deployment-requirements)
- [Boundaries and recovery](#boundaries-and-recovery)
- [Dev Note](#dev-note)

-----

<a id="evaluate-the-preview"></a>
## Evaluate the preview

Use the [employee overlay](../../../apps/cli/config/examples/employee-readonly/cordis.yml) on a clean stock Web profile. The adjacent [preset](../../../apps/cli/config/examples/employee-readonly/presets/employee-readonly/agent.cordis.yml) supplies a complete business persona and the three read tools. Do not combine this overlay with operator coding or maintenance patches.

The built-checkout acceptance commands below start private temporary Web processes and use synthetic model responses. They do not access a production Frappe site or require model credentials. Build artifacts must already exist.

```sh
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.expected.config.ts apps/cli/tests/profiles/employee-readonly
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/employee-readonly.snapshot.ts scripts/session-snapshot-corpus.corpus.ts
```

A passing run demonstrates rejected HTTP and WebSocket operations, an unavailable shell tool, credential and session separation between two Hosts, and durable session recovery. The recorded-session test pins the complete model prompt, tool schemas, and refusal transcript.

-----

<a id="deployment-requirements"></a>
## Deployment requirements

An operator must provision the following values before a live evaluation. The test fixture materializes local package dependencies without a registry download; it is not an employee account installer.

| Input | Required ownership |
|---|---|
| Web profile and installed packages | Operator-owned stock base/Web layers with resolvable Native Bench Frappe and persona plugins; no employee-editable patches |
| Private state | A separate process, workspace, `DSH_HOME`, `DSH_AGENTS_HOME`, persistence root, and browser credential for each employee |
| `DSH_EMPLOYEE_PRESET_ROOT` | Absolute operator-owned path to this overlay's adjacent `presets` directory; no other preset roots |
| `DSH_EMPLOYEE_BENCH_ROOT`, `DSH_EMPLOYEE_SITE` | Explicit Native Bench directory and target site |
| `DSH_EMPLOYEE_USER`, `DSH_EMPLOYEE_ASSERTION_FILE` | Fixed Frappe user and private, short-lived signed identity assertion; maintain renewal outside the conversation |
| `DSH_EMPLOYEE_DOCTYPES` | JSON array of explicitly approved existing DocType names; an empty array grants no document access |
| Model and network | Operator-controlled provider configuration, loopback binding, and an authenticated employee-to-Host proxy before remote exposure |

Pass the overlay with the launcher's `--patch` option before Web application flags, as the [real-process fixture](../../../apps/cli/tests/profiles/employee-readonly/harness.ts) does. Keep signing material, assertion contents, and browser launch credentials out of prompts, URLs shared with other employees, logs, and Git.

-----

<a id="boundaries-and-recovery"></a>
## Boundaries and recovery

The Gateway allows only explicitly named conversation and read-only discovery endpoints. Preset authoring and switching, configuration mutation, workspace opening, attachments, model switching, and forking are denied. The model receives no shell, filesystem, code, command, subagent, workflow, or maintenance tools. Source configuration remains trusted executable code, not a request-controlled permission setting.

An expired assertion or Frappe permission denial must be reported to the operator; the assistant must not switch identity or fall back to an unrestricted interface. Keep source DocType names and Frappe authorization authoritative. This overlay creates no DocType and changes no business record or role permission.

Separate processes and directories provide application-level separation, not an operating-system sandbox for processes sharing one Unix account. The allowed event stream covers its entire private Host. Proxy routing, employee login, active-WebSocket revocation, real-account row permissions, and model-provider data handling still need deployment acceptance. Never attach different employees to one Host and call that isolation.

The stock Web shell can retain controls whose operations this overlay denies. Automated checks cover HTTP, WebSocket, model requests, and persistence, not a completed visual workflow or a live employee SSO login. Operators must complete browser and real-account acceptance before publishing an employee entry point.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
