# `@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules`

[English](README.md) | 中文

本包为童健云周食谱营养业务提供八个原生 Harness 工具。两个只读工具基于童健云真实数据解释按学生名册加权或手动选择的全日标准，并计算最新或指定食谱；另外六个受控工具覆盖营养规则生命周期：查询规则、创建草稿、试算草稿、提交审核、发布已审核规则，以及把历史规则恢复为一个新的已发布版本。它直接调用童健云已认证的 Frappe MCP 方法；MCP 凭据和可选的当前用户断言不会出现在模型可见的工具结构或结果中。

请通过 Profile 或 Bundle 补丁配置本包。`credentialRef` 指向凭据库中的 Frappe 集成账号，值为 `api_key:api_secret`。`actorTokenRef` 可选，指向每次调用都会解析的、由受信任身份系统签发的当前用户断言；仅在童健云服务器启用该校验时配置。`timeoutMs` 由 Harness 的工具超时策略执行。

```yaml
- id: tongjianyun-nutrition-rules
  name: '@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules'
  config:
    endpoint: https://child.myyr.top/api/method/ione_core.mcp.server.handle_mcp
    credentialRef: IONE_TONGJIANYUN_MCP_TOKEN
    actorTokenRef: IONE_TONGJIANYUN_ACTOR_TOKEN
    timeoutMs: 30000
```

Frappe 集成账号仍受童健云服务端角色权限、审计记录、规则状态流转以及精确确认文本的约束：发布为 `确认发布`，回滚为 `确认回滚`。本插件会在请求前校验确认文本，服务端会再次校验。稳定的系统提示区段要求模型先调用只读取证工具，再回答童健云标准或真实食谱结果的问题；如果 Frappe 调用失败，模型必须说明证据不可用，不得编造计算过程。

## Model Experience

### Nutrition-rule tool schemas

#### What the model sees

八个工具结构列在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-tongjianyun-nutrition-rules)中。工具结果仅包含 Frappe 返回的结构化结果；API 凭据、HTTP 请求头、接口地址和可选的用户断言均不会进入模型上下文。固定路由区段会告诉模型何时使用 `tongjianyun_explain_nutrition_standard` 或 `tongjianyun_get_weekly_nutrition_analysis`。

#### Token effect

插件挂载期间，每次模型请求均带有固定的原生工具结构集合和固定路由区段。每次完成调用会按普通工具结果流程追加结构化营养结果；结果大小由童健云 MCP 服务端控制。

#### KV Cache effect

在插件配置不变且已挂载时，工具结构前缀保持稳定。挂载、卸载或修改工具定义会替换该前缀并可能使缓存复用失效；凭据轮换和每次调用的用户断言不会改变该前缀。

## Known Limitations and Deferred Work

- **受信任的用户断言来源** — `actorTokenRef` 只能读取为当前 Harness 用户提供新鲜断言的凭据提供方。不支持静态长期用户令牌；启用用户身份校验的部署需要一个能够刷新该引用的受信任身份桥接层。
- **Frappe 结果边界** — 规则列表和试算结果的分页及载荷限制由服务端负责。本插件保留结构化结果，不另行设置第二套截断策略。
