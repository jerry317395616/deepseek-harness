# `@deepseek-ai/dsh-tool-native-bench-frappe`

[English](README.md) | 中文

本包让 Agent 能够发现当前 Native Bench 平台、检查安全的 DocType 元数据、读取获准的业务文档，并在用户批准后更新现有记录的标量字段。每项操作均使用部署固定账号通过 Frappe 执行，因此权限、文档校验、hooks 和常规 Version 记录仍是依据。适配器在 Bench 本地运行，不调用 HTTP MCP 接口、不执行任意 SQL，也不执行模型提供的 Python。

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

`native_bench_frappe_platform_catalog` 返回已安装应用和当前账号可读取的 DocType，`native_bench_frappe_describe_doctype` 返回安全字段和实际 CRUD 权限。`native_bench_frappe_list_documents` 支持结构化过滤、单字段排序、最多100行分页和最多64个明确字段；`native_bench_frappe_get_document` 使用相同的字段限制读取单条记录。基础设施 DocType（包括用户、角色、文件、凭据、结构和系统配置）会被阻止，敏感字段名会脱敏。

更新由两次工具调用组成。`native_bench_frappe_preview_document_update` 在不改变数据的情况下校验记录、字段、值和写权限，然后返回与文档 `modified` 值及请求变更绑定的 `preview_id`。`native_bench_frappe_apply_document_update` 要求完全相同的参数和编号，通过 Harness 标准审批服务请求用户一次性批准，拒绝过期预览，并通过正常 Frappe 文档生命周期保存。该流程只接受现有业务记录和标量字段。

独立的 `@deepseek-ai/dsh-tool-native-bench-source` 包负责在同一个 Bench 下搜索和读取源码。两者结合后可以覆盖所有已安装应用的源码和受权限控制的业务数据，不再局限于童健云。

## 模型体验

### Native Bench Frappe 平台工具

#### 模型可见内容

本包提供固定路由区段，以及生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-native-bench-frappe)中的六个工具结构：平台目录、DocType 描述、列表／单条读取、更新预览和审批后更新。工具结果只包含有界且已清理的元数据和记录；辅助脚本路径、Python 命令、站点路径和固定账号不会成为模型参数。

#### Token effect

路由区段大小固定且较小。结果大小受行数、字段数、输入和输出限制控制，具体见上文及配置结构。

#### KV Cache effect

挂载或卸载本包会改变系统提示和工具前缀；数据库内容不会改变本包的提示贡献。

## 已知限制和后续工作

- **只更新现有记录的标量字段** — 新建、删除、提交、取消、子表、附件、结构、报表和任意 SQL 操作均不可用；需要这些操作的流程必须由应用专用服务负责。
- **受保护 DocType** — 即使固定 Frappe 账号原本可访问，安全、凭据、用户、角色、文件、结构和系统 DocType 也会被排除。
- **部署管理身份** — 固定的 `frappeUser` 由部署管理，只应授予已安装应用所需角色，不能从工具参数传入。
