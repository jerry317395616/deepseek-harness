---
description: "Read Native Bench Frappe records with bounded permissions, or apply approved scalar updates in a maintenance runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-native-bench-frappe

English | [中文](README.zh.md)

## Summary

Use this package to inspect safe Frappe metadata and read permitted business records from the active Native Bench. A maintenance runtime can also preview and apply approved scalar updates to existing records. An opt-in business runtime accepts only scoped reads under a signed, explicitly pinned user identity. Frappe permissions remain authoritative. An optional loopback login helper routes pre-provisioned employee hosts; it does not make a shared host multi-user safe.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package through a profile or Bundle patch. The deployment owns the Bench root, site, executable, account and scope; a model call cannot supply them.

### Maintenance configuration

This configuration retains discovery, description, list/get reads, update preview and approved update apply:

```yaml
- id: native-bench-frappe
  name: '@deepseek-ai/dsh-tool-native-bench-frappe'
  config:
    accessMode: maintenance
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

| Field | Default | Meaning |
|---|---|---|
| `accessMode` | `maintenance` | Business mode exposes only scoped describe/list/get operations. |
| `frappeUser` | Empty | Maintenance resolves empty to Administrator; business requires an explicit account. |
| `actorTokenFile` | Empty | Business requires an absolute path to a private signed assertion file. |
| `businessDoctypes` | Empty | Business requires 1–64 explicitly named DocTypes. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-native-bench-frappe) owns the full field contract. Maintenance rejects business credentials and scope instead of ignoring them.

### Business identity and reads

Business mode registers only description, list and get. Both the TypeScript client and Python entrypoint reject discovery, updates and out-of-scope DocTypes. The Python helper reads an owner-only regular POSIX assertion file of at most 4096 bytes; it rejects final-component symlinks and hardlinks. It delegates signature, site, expiry and account resolution to `ione_core.mcp.identity.resolve_actor_user`. The verified account must exactly match `frappeUser`, and both modes require an enabled System User.

A trusted bridge must supply and refresh one assertion for each isolated user runtime. The separate [Native Bench renewer](#native-bench-assertion-renewal) provides that deployment operation; it does not associate shared Web sessions with users. Do not use the shared maintenance host as a staff deployment: other plugins, Web APIs, sessions and filesystem access need separate isolation.

List reads use structured filters, one-field sorting, up to 100 rows and up to 64 selected fields. Get reads use the same field limit. Protected infrastructure DocTypes and sensitive fields are excluded. Identity failures return fixed diagnostics; credential contents are absent from tool arguments, subprocess arguments and tool results.

<a id="employee-login-routing-helper"></a>
### Employee login routing helper

The optional [Python helper](python/employee_gateway.py) accepts the signed handoff format emitted by the deployed Frappe launcher. It is not mounted by the Cordis plugin and does not start automatically. Its private JSON configuration requires these fields; unknown fields fail startup:

| Field | Required value |
|---|---|
| `version` | `1` |
| `issuer` | Exact issuing site hostname. |
| `public_origin` | Exact HTTPS origin used for logout verification. |
| `secret_file` | Absolute owner-only file holding the launcher signing key. |
| `port` | Explicit loopback listener port, 1024–65535. |
| `session_seconds` | Absolute login-session lifetime, 60–28800 seconds. |
| `max_sessions` | Maximum live login sessions, 1–4096; replay entries are capped at four times this limit. |
| `bindings` | 1–256 explicit `user`, `upstream`, `home`, `launch_file` objects. |

Each binding requires a distinct `http://127.0.0.1:port`, non-overlapping owner-only home, and distinct private launch credential inside that home. Guest and Administrator bindings are refused. Configuration is immutable during one process lifetime. A request cannot choose or override an upstream. Invalid, expired, future-dated, reused or unbound-user handoffs return 401; a handoff must be issued strictly after process startup and last at most 60 seconds. Restart invalidates login sessions and rejects tickets issued before startup; obtain a new handoff after the first whole second.

The reverse proxy must make `GET /auth` internal and use only its verified `X-Harness-Upstream` response for **every HTTP request and WebSocket upgrade**. `GET /sso?token=…` exchanges a handoff for a Secure, HttpOnly host cookie and redirects to that employee's launch URL. Same-origin `POST /logout` removes that login session. The helper omits request logging and sends no-store/no-referrer headers; deployment proxies must also omit credential query strings. It does not proxy traffic or protect direct runtime ports.

The optional [traffic proxy](python/employee_proxy.py) owns HTTP forwarding and active WebSocket revocation. Its separate private configuration accepts exactly `gateway_config`, `python`, `identity_configs`, `recheck_seconds` and `check_seconds`. `gateway_config` references the routing configuration above; `python` is the absolute Bench interpreter; `identity_configs` maps every bound employee to an existing private renewer configuration whose user and site match that binding. Both deadlines are explicit positive seconds, at most 30. The proxy runs in a separate Python environment with [its pinned transport dependency](python/requirements-employee-proxy.txt); it invokes the Bench interpreter only for the trusted renewer's read-only `--check` operation.

The proxy checks identity before forwarding and before returning HTTP data, before relaying each WebSocket data message, and while streams are idle. Logout, expiry, a disabled account or a failed identity dependency closes both ends; idle detection is bounded by the recheck interval plus the check deadline, followed by a close handshake bounded to two seconds. It rejects cross-origin writes and WebSocket upgrades, hides `/auth`, and never accepts a caller-selected upstream. HTTP bodies are bounded to 1 MiB inbound and 16 MiB outbound; WebSocket messages are bounded to 1 MiB. TLS termination, direct-port protection, private configuration and proxy log redaction remain deployment responsibilities.

The [transport suite](tests/test_employee_proxy.py) covers revocation and cleanup. With `DSH_EMPLOYEE_PROXY_PYTHON` pointing to that isolated interpreter, the [employee Web fixture](../../../apps/cli/tests/profiles/employee-readonly/proxy.ts) drives real Web hosts and the existing recorded session through disposable proxy identities. This is keyless transport evidence, not a live Frappe SSO or browser certification. Disconnecting a client does not cancel or roll back work already accepted by Harness. Provisioning, live SSO integration and production load testing remain separate deployment work.

The site-pinned [live acceptance operator](../../../scripts/employee-live-acceptance.py) defaults to a read-only preview. On the configured Native Bench, an authorized operator may run it with `--run --expected-students N` after verifying that preview. It admits only its two existing disabled test accounts with exact roles and an unchanged class permission roster, serializes runs, temporarily enables them, and resets their passwords through the Frappe password service. It uses real HTTPS login and signed Frappe handoffs, dedicated Web profiles and a loopback scripted model to verify record permissions and active-connection revocation. It disables the accounts and clears their sessions in cleanup, checks business-record and permission fingerprints, and removes its private runtime directories after stopping owned processes. Abrupt host failure or SIGKILL can prevent cleanup; operators must then disable the named test accounts and clear their sessions through Frappe. The script requires built Harness output, the Bench interpreter and the separately installed proxy dependency; it does not change production routing or certify public TLS, browser cookie behavior, financial calculations, or isolation from hostile local processes.

<a id="native-bench-assertion-renewal"></a>
### Native Bench assertion renewal

The optional [renewer](python/native_actor_refresh.py) runs with the active Bench Python environment as a trusted deployment process, not a model tool. Its `--config` argument names an owner-only JSON file with these exact fields:

| Field | Required value |
|---|---|
| `version` | Integer `1`. |
| `bench_root` | Absolute canonical Native Bench directory containing the site. |
| `site` | Exact site hostname. |
| `user` | Exact enabled System User name; Guest and Administrator are refused. |
| `assertion_file` | Absolute file in a canonical owner-only directory. |
| `ttl_seconds` | Explicit integer lifetime, 60–900 seconds. |

The renewer reads the current account through Frappe ORM, signs the deployed I-ONE assertion format internally, and checks it through `ione_core.mcp.identity.resolve_actor_user` before publication. It never prints signing material or assertions, never copies credentials into model configuration, and never commits business records. `--check` verifies identity without publishing or revoking a file; success prints `employee identity verified`. Normal success prints `employee assertion refreshed`; failure exits nonzero with `employee assertion refresh failed`.

Publication uses an exclusive private temporary file, file synchronization and atomic rename. Existing symlinks, hardlinks and public destinations are refused. Once a safe destination is open, a renewal failure revokes its previous assertion. Configuration/open failures and process termination can leave the earlier assertion until expiry. The deployment scheduler must serialize runs and renew before expiry; it must also stop renewal when an employee binding is removed. Removing a binding does not make its existing file disappear automatically.

The issuer needs privileged local access to the site's signing configuration and database. Employee runtimes must not control this process, its configuration or the signing material. Private files owned by the same operating-system user do not isolate mutually untrusted processes. This helper does not repair a shared-host authorization policy or activate employee Web access.

### Approved maintenance updates

Preview checks an existing record and its proposed scalar changes without saving. Apply requires the exact preview id, document version and values, plus one-shot approval through Harness. It saves through the Frappe document lifecycle, so validation, hooks and ordinary Version tracking remain authoritative. Create, delete, submit, cancel, child-table and schema changes are not exposed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [plugin](src/index.ts) selects the tool surface and approval policy. The [client](src/native.ts) checks deployment scope before spawning the [Python helper](python/native_frappe_query.py). The helper checks policy before database startup, verifies the actor before business reads, and uses Frappe ORM permissions rather than arbitrary SQL or model-supplied Python. The [Loader tests](tests/loader-composition.spec.ts), [credential-free Python tests](tests/test_business_identity.py) and [recorded denial session](../../../snapshots/session/native-frappe-business-denial/session.jsonl) exercise the boundaries at different layers.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These owners cover the adjacent integration boundaries.

- [Native Bench source tools](../tool-native-bench-source/README.md) — source inspection and extension planning.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-native-bench-frappe) — model-facing parameter contracts.
- [Testing policy](../../../docs/testing.md) — focused tests and keyless session replay.

-----

<a id="model-experience"></a>
## Model Experience

### Native Bench Frappe platform tools

#### What the model sees

Maintenance contributes a routing section and six tool schemas; business contributes a scoped-read routing section and three schemas, including `native_bench_frappe_get_document`. The login routing helper contributes no model tools. Results contain bounded, sanitized metadata or records. The configured account, site path, assertion path and executable are not model-call parameters.

#### Token effect

The routing section is fixed for the selected mode. Row, field, input and output limits bound result size.

#### KV Cache effect

Changing the mounted mode changes the system-prompt and tool prefix. Database content does not change the prompt contribution.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The adapter constrains its own tools, not the complete application host.

- **No shared-host authorization** — the login helper routes distinct hosts, not owners inside one host; provisioning and scheduling the separate assertion renewer remain deployment work.
- **No class-ownership policy** — a DocType allowlist does not restrict a teacher to one class; Frappe role and record permissions must enforce that separately.
- **No general workflow engine** — only approved maintenance scalar updates are writable; domain services must own other business transitions.
- **No host-wide isolation** — other plugins, Web APIs, attachments and filesystem access need independent authorization. Business mode must not be enabled on a shared maintenance host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
