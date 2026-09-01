# `@deepseek-ai/dsh-tool-native-bench-frappe`

[English](README.md) | 中文

本包为当前 Native Bench 的 Frappe 站点提供两个面向模型的只读工具。工具通过 Frappe ORM 列出和读取允许的 DocType，因此固定部署账号的权限和站点业务规则仍是依据。适配器在 Bench 本地运行，不调用 HTTP MCP 接口、不执行任意 SQL，也不执行模型提供的 Python。

请通过 Profile 或 Bundle 补丁配置。Bench 根目录、站点、Python 可执行文件和固定 Frappe 账号均由部署管理，模型调用不能提供这些值。

```yaml
- id: native-bench-frappe
  name: '@deepseek-ai/dsh-tool-native-bench-frappe'
  config:
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

`native_bench_frappe_list_documents` 支持结构化过滤、单字段排序、最多100行分页和最多64个明确字段。`native_bench_frappe_get_document` 使用相同的字段边界读取单条记录。基础设施 DocType（包括用户、角色、文件、凭据和系统配置）会被阻止，敏感字段名会脱敏；每次请求前都会检查 Frappe 读取权限。

独立的 `@deepseek-ai/dsh-tool-native-bench-source` 包负责在同一个 Bench 下搜索和读取源码。两者结合后可以覆盖所有已安装应用的源码和受权限控制的业务数据，不再局限于童健云。

## 模型体验

### Native Bench Frappe 读取工具

#### 模型可见内容

本包提供固定路由区段，以及生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-native-bench-frappe)中的 `native_bench_frappe_list_documents` / `native_bench_frappe_get_document` 工具结构。工具结果只包含有界且已清理的 Frappe 记录；辅助脚本路径、Python 命令、站点路径和固定账号不会成为模型参数。

#### Token effect

路由区段大小固定且较小。结果大小受行数、字段数、输入和输出限制控制，具体见上文及配置结构。

#### KV Cache effect

挂载或卸载本包会改变系统提示和工具前缀；数据库内容不会改变本包的提示贡献。

## 已知限制和后续工作

- **数据库只读边界** — 本包不会新增、更新或删除记录，不修改架构，不运行报表，也不执行任意 SQL。上述操作需要单独的审批管理流程。
- **受保护 DocType** — 即使固定 Frappe 账号原本可读，安全、凭据、用户、角色、文件和系统 DocType 也会被排除。
- **部署管理身份** — 固定的 `frappeUser` 由部署管理，只应授予已安装应用所需角色，不能从工具参数传入。
