---
description: "Freeze DocType changes and arbitrary execution in a Native Bench Harness deployment."
---
# Native Bench business policy

English | [中文](native-bench-business.zh.md)

## Summary

Ordinary conversations use deployed business capabilities without gaining coding or schema authority. The Host policy rejects arbitrary scripts, source edits, metadata writes and migration. Existing business reads and approved scalar updates retain their Frappe checks. This is a capability restriction, not a completed shared-user authorization system.

## Table of Contents

- [Deploy](#deploy)
- [Verify](#verify)
- [Boundaries and recovery](#boundaries-and-recovery)
- [Dev Note](#dev-note)

<a id="deploy"></a>
## Deploy

Build the trusted checkout and make the source package, including its policy subpath, resolvable from the Web profile. Keep the profile's existing model and Native Bench provider configuration private. Apply the [overlay](../../../apps/cli/config/examples/native-bench-business/cordis.yml) last:

```sh
pnpm dsh web --patch ./apps/cli/config/examples/native-bench-business/cordis.yml --no-open --host 127.0.0.1 --port 13090
```

Run from the Harness repository, or set `DSH_NATIVE_BENCH_BUSINESS_PRESET_ROOT` to its operator-owned preset directory. Set `DSH_NATIVE_BENCH_BUSINESS_WORKSPACE` if the active Tongjianyun directory differs from `/home/zyd/frappe/native-bench/apps/tongjianyun`. The policy is Host-global, never a user-selectable plugin. Restart the existing service to replace loaded configuration and close old connections.

The business preset becomes the default. Shipped presets remain available for historical conversations, but cannot bypass the global guard. Remote configuration, model switching, preset authoring and native file opening are denied. Approval replies remain available for existing controlled record updates; they do not override forbidden tools.

<a id="verify"></a>
## Verify

```sh
pnpm exec vitest run packages/extensions/tool-native-bench-source/tests
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s packages/extensions/tool-native-bench-frappe/tests -p test_schema_freeze.py
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/native-bench-business.snapshot.ts
```

The recording starts the shipped Web CLI with synthetic model responses. It verifies chat persistence, script refusal, absent coding schemas and denied configuration RPCs. Package tests cover forced-approval rejection, field planning, migration and indirect metadata carriers. These tests do not modify a production site.

<a id="boundaries-and-recovery"></a>
## Boundaries and recovery

- Every DocType change is prohibited, including Custom Field, Property Setter, permissions, naming, scripts, workflow metadata and indirect migrations.
- Existing documents are not schema definitions. Their permitted scalar updates still require preview, approval and the deployed Frappe user's permissions.
- Safe UI and report creation executors are not implemented here; a plan is not an execution.
- Shared-login actor binding, conversation ownership and business-role isolation require separate deployment work. Do not grant a fixed privileged bridge to untrusted shared users.
- Host administrators, direct Frappe administrator access and operating-system access are outside this tool policy. Keep configuration and plugin directories operator-owned.
- On startup failure, keep the service stopped while repairing the locked overlay. Removing the overlay reopens authority and is not an acceptable ordinary-user fallback.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

The [package reference](../../../packages/extensions/tool-native-bench-source/README.md) owns tool semantics and remaining limitations. No new DocType or Frappe schema modification is required.

</details>
