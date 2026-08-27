# `@deepseek-ai/dsh-ione-native-bench-source`

English | [中文](README.zh.md)

This opt-in Bundle inserts `@deepseek-ai/dsh-tool-native-bench-source`. A later profile or home patch must enable the row and supply the deployment-owned Native Bench root.

```yaml
- id: native-bench-source
  name: '@deepseek-ai/dsh-tool-native-bench-source'
  disabled: false
  config:
    benchRoot: /home/zyd/frappe/native-bench
```

## Model Experience

### Bundle composition

#### What the model sees

The Bundle itself adds no prompt text; the inserted `@deepseek-ai/dsh-tool-native-bench-source` package contributes the Native Bench source routing and tool schemas.

#### Token effect

Zero while the Bundle row is disabled. When enabled, the inserted package contributes its documented routing section and tools.

#### KV Cache effect

Enabling or disabling the Bundle changes the mounted prompt and tool prefix. Changes to source files do not change the Bundle's prompt contribution.

## Known Limitations and Deferred Work

- **Deployment-owned activation** — the Bundle deliberately remains disabled until a profile supplies an explicit Native Bench root.
