---
description: "按需启用、具备权限感知能力的 Native Bench Frappe 平台工具 Bundle。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-ione-native-bench-frappe`

[English](README.md) | 中文

## 概述

这是一个可选 Bundle，会插入 `@deepseek-ai/dsh-tool-native-bench-frappe`。后续 Profile 或 home 补丁必须启用该行，并提供部署管理的 Native Bench 根目录、站点和 Frappe 账号。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

```yaml
- id: native-bench-frappe
  name: '@deepseek-ai/dsh-tool-native-bench-frappe'
  disabled: false
  config:
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

本包提供平台目录和 DocType 元数据工具、有界列表／单条读取，以及针对现有业务记录标量字段的预览加审批更新流程。它使用本地 Frappe 文档 API，检查固定账号的权限，阻止基础设施、结构和凭据类 DocType，脱敏敏感字段，并且不接受 SQL 或任意 Python。源码检索仍由 Native Bench 源码 Bundle 负责。

-----

<a id="model-experience"></a>

## 模型体验

### Bundle 组合

#### 模型可见内容

Bundle 本身不添加提示文本；插入的包会提供 Frappe 平台路由，以及[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-native-bench-frappe)中记录的六个发现、读取、预览和执行工具结构。

#### Token effect

Bundle 行禁用时为零。启用后，插入的包会贡献文档中说明的路由区段和工具。

#### KV Cache effect

启用或禁用 Bundle 会改变已挂载的提示前缀和工具前缀；数据库内容变化不会改变 Bundle 的提示贡献。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

- **部署管理启用** — 在 Profile 提供明确的 Native Bench 根目录、站点和固定 Frappe 账号前，Bundle 会保持禁用。
- **窄写入边界** — 只允许更新现有业务记录经过批准的标量字段；新建、删除、提交、取消、子表、报表、结构和任意 SQL 操作仍不可用。
- **受保护记录** — 凭据、用户、角色、文件、系统配置及其他基础设施 DocType 即使固定账号可读，也会被排除。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

实现和部署边界记录在 [Native Bench 证据 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-27-native-bench-source-evidence.zh.md) 中。

</details>
