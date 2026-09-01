# `@deepseek-ai/dsh-ione-native-bench-frappe`

[English](README.md) | 中文

这是一个可选 Bundle，会插入 `@deepseek-ai/dsh-tool-native-bench-frappe`。后续 Profile 或 home 补丁必须启用该行，并提供部署管理的 Native Bench 根目录和 Frappe 账号。

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

本包为允许的 Frappe DocType 提供有界的列表和单条读取工具。它使用本地 Frappe ORM，检查固定账号的权限，阻止基础设施和凭据类 DocType，脱敏敏感字段，并且不接受 SQL 或任意 Python。源码检索仍由 Native Bench 源码 Bundle 负责。

## 模型体验

### Bundle 组合

#### 模型可见内容

Bundle 本身不添加提示文本；插入的包会提供通用 Frappe 数据库读取路由，以及[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-native-bench-frappe)中记录的 `native_bench_frappe_list_documents` / `native_bench_frappe_get_document` 工具结构。

#### Token effect

Bundle 行禁用时为零。启用后，插入的包会贡献文档中说明的路由区段和工具。

#### KV Cache effect

启用或禁用 Bundle 会改变已挂载的提示前缀和工具前缀；数据库内容变化不会改变 Bundle 的提示贡献。

## 已知限制和后续工作

- **部署管理启用** — 在 Profile 提供明确的 Native Bench 根目录、站点和固定 Frappe 账号前，Bundle 会保持禁用。
- **数据库只读边界** — 新增、更新、删除、报表和架构变更仍属于单独的审批流程；本包不会暴露任意 SQL 或写操作。
- **受保护记录** — 凭据、用户、角色、文件、系统配置及其他基础设施 DocType 即使固定账号可读，也会被排除。
