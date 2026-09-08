---
description: "用于同步版 Frappe 官方文档检索工具的可选 Bundle。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-ione-frappe-docs`

[English](README.md) | 中文

## 概述

本可选 Bundle 会插入 `@deepseek-ai/dsh-tool-frappe-docs`。后续 Profile 或 home 补丁负责启用该行，并提供由部署管理的知识库路径。Bundle 不会同步内容；运维人员需要单独运行包内同步程序。

## 目录

- [使用方法](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与待处理工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>

## 使用方法

```yaml
- id: frappe-docs
  name: '@deepseek-ai/dsh-tool-frappe-docs'
  disabled: false
  config:
    knowledgeRoot: /home/zyd/frappe/frappe-docs-kb
    pythonExecutable: /usr/bin/python3
    timeoutMs: 30000
```

<a id="model-experience"></a>
## 模型体验

### Bundle 组合

#### 模型看到的内容

Bundle 本身不添加提示文本。启用后，插入的包会提供证据优先级提示区段，以及生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-frappe-docs)中的三个只读工具结构。

#### Token 影响

Bundle 行停用时为零。启用后，插入的包会提供固定提示区段和工具。

#### KV 缓存影响

启用或停用 Bundle 会改变系统提示和工具前缀。同步索引不会改变 Bundle 组合。

## 已知限制与待处理工作
<a id="known-limitations-and-deferred-work"></a>

- **由部署负责同步**——本地索引存在并由部署层提供绝对路径之前，Bundle 会保持停用。
- **只读检索**——插入的包不能同步、编辑或发布官方文档。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

Bundle 和部署边界记录在 [Frappe 文档知识库 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-frappe-docs-knowledge-base.zh.md) 中。

</details>
