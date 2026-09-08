---
description: "为部署方管理的 Harness Profile 提供可选的 Native Bench 源码证据层。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-ione-native-bench-source`

[English](README.md) | 中文

## 概述

这是一个可选组合包，用于插入 `@deepseek-ai/dsh-tool-native-bench-source`。安装后需要由 Profile 或主目录补丁启用该行，并提供部署拥有的 Native Bench 根目录。

## 目录

- [部署配置](#deployment-configuration)
- [模型体验](#model-experience)
- [已知限制与待处理工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="deployment-configuration"></a>
## 部署配置

```yaml
- id: native-bench-source
  name: '@deepseek-ai/dsh-tool-native-bench-source'
  disabled: false
  config:
    benchRoot: /home/zyd/frappe/native-bench
```

## Model Experience

### 组合包组成

#### What the model sees

组合包自身不添加提示文本；插入的 `@deepseek-ai/dsh-tool-native-bench-source` 会提供 Native Bench 源码路由和工具结构。

#### Token effect

组合包行禁用时为零。启用后，插入的工具包会贡献其文档所述的路由区段和工具。

#### KV Cache effect

启用或禁用组合包会改变已挂载的提示和工具前缀；源码文件变化不会改变组合包自身的提示贡献。

## Known Limitations and Deferred Work

- **部署方启用** — 组合包默认保持禁用，直到 Profile 提供明确的 Native Bench 根目录。

<a id="dev-note"></a>
### 开发备注

无。
