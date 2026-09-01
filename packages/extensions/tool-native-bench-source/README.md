# `@deepseek-ai/dsh-tool-native-bench-source`

English | [中文](README.zh.md)

Registers read-only tools for the Frappe Bench that is currently serving the site. The deployment pins the Native Bench root explicitly, so source discovery does not depend on the Harness process working directory. The tools search and read `apps/`, `sites/`, and `config/` through bounded operations and never expose site secrets, environment files, logs, or arbitrary paths.

Configure the package in a profile or home patch:

```yaml
- id: native-bench-source
  name: '@deepseek-ai/dsh-tool-native-bench-source'
  config:
    benchRoot: /home/zyd/frappe/native-bench
    maxMatches: 200
    timeoutMs: 30000
```

`native_bench_search_code` uses the packaged ripgrep binary and returns stable paths, line numbers, and bounded previews. `native_bench_read_file` reads a bounded line window from an allowlisted source or configuration file. `native_bench_runtime_status` returns the safe Bench manifest without credentials. The tools are read-only and do not change the Bench or the Frappe site.

## Model Experience

### Native Bench source tools

#### What the model sees

The three tool schemas are listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-native-bench-source). A fixed routing section tells the model to search `/home/zyd/frappe/native-bench/apps` before reading source context or interpreting current Frappe data.

#### Token effect

One fixed routing section and three tool schemas join each request while this package is mounted. Search and read results append only the bounded paths, line windows, and previews returned by the tools.

#### KV Cache effect

The routing section and schemas are prefix-stable while the package configuration is unchanged. Mounting, unmounting, or changing the tool definitions replaces that prompt prefix; changing source files or runtime data does not change it.

## Known Limitations and Deferred Work

- **Runtime source parity** — Native Bench app directories do not carry a Git revision in every deployment. The tools therefore identify the configured root and return source paths, but a separate release manifest or file hash is needed for historical version comparison.
- **Database operations remain a separate package** — this package never executes SQL or reads Frappe documents directly. The Tongjianyun nutrition package uses a separately allowlisted local Frappe adapter for permission-aware read evidence; MCP remains an explicit compatibility mode for network deployments.
