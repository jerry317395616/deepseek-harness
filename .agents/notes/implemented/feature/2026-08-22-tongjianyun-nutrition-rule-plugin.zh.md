# Agent Note：童健云营养规则插件

状态：已实现

[English](2026-08-22-tongjianyun-nutrition-rule-plugin.md) | 中文

## Problem

童健云周食谱营养计算流程需要成为正式 Harness 插件，而不是仅能由 IONE Agent 内部 Skill 调用。模型调用必须保留 Frappe 后端的草稿、试算、审核、发布、回滚、角色权限、审计和确认控制，同时不能暴露 API 凭据或用户断言。

## Decision

`@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules` 在 `ctx.tools` 上注册八个原生工具，并向已认证的 Frappe MCP 方法发送标准 JSON-RPC `tools/call` 请求。两个只读取证工具解释按学生名册加权或手动选择的全日参考值计算并分析真实周食谱，六个工具继续承担受控规则生命周期。固定的 `ctx.systemPrompt` 区段要求模型先调用这些取证工具，再回答童健云标准或真实食谱问题。每次调用前，它都会从 `ctx.credentials` 解析 Frappe 集成凭据和可选的当前用户断言。`@deepseek-ai/dsh-ione-tongjianyun-nutrition-rules` Bundle 默认以禁用状态插入工具行，各部署环境通过自己的接口地址和凭据引用启用该行。

两个不可逆操作在工具体和 Frappe 中均要求精确中文确认文本。服务端仍是权限检查、审计记录、规则状态流转和同一确认文本的最终权威。

## Alternatives considered

**仅保留 IONE Agent Skill** — 不采用。它不能作为 Harness 插件被发现或组合，也不能参与普通工具注册表、Loader 生命周期、Bundle 配置或正式插件目录。

**使用通用 MCP 客户端包** — 不采用。童健云方法使用 Frappe 特有的 JSON-RPC 信封，并且需要每次调用的凭据和可选的隐藏当前用户断言。通用接口声明无法建立这些领域控制。

## Consequences

营养规则生命周期和取证路径以八个边界清晰的原生工具结构向模型呈现，可通过普通 Harness Bundle 组合安装，并会随 Loader Fiber 干净卸载。路由区段避免把工作区源码搜索误当成童健云证据。凭据值保留在凭据提供方中，不会出现在工具结构、提示词、结果或配置补丁中。

需要 Frappe 用户令牌的部署必须提供受信任身份桥接层，为当前 Harness 用户刷新 `actorTokenRef`。有意不支持静态长期用户令牌。

## Verification

真实 Loader 组合测试从临时 cordis.yml 中挂载 `dsh-tools`、`dsh-system-prompt`、`dsh-credentials-local` 和营养插件。测试对八个工具注册及路由文本做快照，证明每个调用均映射到对应 Frappe MCP 工具，凭据和用户断言只存在于请求中，无效的高风险确认不会发送到传输层，并且释放 Loader 条目会同时移除工具和路由提示。
