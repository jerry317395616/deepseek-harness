---
description: "通过 Native Bench 或已认证的 MCP 提供童健云营养分析和受控规则操作。"
kind: "package-reference"
---

# `@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules`

[English](README.md) | 中文

## 概述

本包为童健云周食谱营养业务提供十个原生 Harness 工具。三个只读工具分别解释单项标准、一次对比4岁/5岁/6岁全部标准，以及基于真实数据计算最新或指定食谱；六个受控工具覆盖营养规则生命周期，另一个负责发布生成的报告。默认 `native` 模式会在当前 Native Bench 进程中直接运行已安装的童健云 Frappe 函数；`mcp` 是用于已认证网络调用和规则写操作的显式兼容模式。

请通过 Profile 或 Bundle 补丁配置本包。Native 模式固定当前 Bench、站点、Python 环境和 Frappe 账号；账号由部署管理，模型不能提供。辅助进程初始化 Frappe 后只允许调用三个只读操作。显式 MCP 模式下，`credentialRef` 指向凭据库中的 Frappe 集成账号，值为 `api_key:api_secret`。动态身份和 `actorTokenRef` 仍兼容。`timeoutMs` 由 Harness 的工具超时策略执行。

## 目录

- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

```yaml
- id: tongjianyun-nutrition-rules
  name: '@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules'
  config:
    transport: native
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

显式 MCP 兼容模式配置：

```yaml
- id: tongjianyun-nutrition-rules
  name: '@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules'
  config:
    transport: mcp
    endpoint: https://child.myyr.top/api/method/ione_core.mcp.server.handle_mcp
    credentialRef: IONE_TONGJIANYUN_MCP_TOKEN
    identitySecretRef: IONE_TONGJIANYUN_IDENTITY_SECRET
    identityEmail: ione-harness-integration@child.myyr.top
    identityUserHint: ione-harness-integration@child.myyr.top
    identityAudience: child.myyr.top
    timeoutMs: 30000
```

身份签名密钥只在插件内部解析，不会进入模型可见的结构、工具结果、日志消息或 HTTP 请求头。请将 Native Frappe 账号保持为启用的专用服务用户并授予三类查询所需角色（或使用部署明确批准的管理员账号）；辅助进程不接受任意 Python、SQL、站点路径或模型提供的用户。

Frappe 账号仍受童健云角色权限、审计记录、规则状态流转以及精确确认文本的约束：发布为 `确认发布`，回滚为 `确认回滚`。Native 模式在启动进程前拒绝所有规则写操作；MCP 模式会在请求前校验确认文本，服务端会再次校验。稳定的系统提示区段要求模型先取源码证据，再读取本地只读数据后回答标准或真实食谱问题；如果 Frappe 调用失败，模型必须说明证据不可用，不得编造计算过程。

生成的报告可以从当前 Native Bench 的 `/home/zyd/frappe/native-bench` 以及兼容的旧报告目录中选择。源码分析由独立的 Native Bench 源码包提供；本包仍负责受权限控制的数据库和报告桥接。

<a id="model-experience"></a>
## Model Experience

### Nutrition-rule tool schemas

#### What the model sees

十个工具结构列在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-tongjianyun-nutrition-rules)中。工具结果仅包含 Frappe 返回的结构化结果；API 凭据、HTTP 请求头、接口地址和可选的用户断言均不会进入模型上下文。固定路由区段会告诉模型何时对比全部年龄组、解释单项标准或计算周食谱。

#### Token effect

插件挂载期间，每次模型请求均带有固定的原生工具结构集合和固定路由区段。每次完成调用会按普通工具结果流程追加结构化营养结果；结果大小由童健云 MCP 服务端控制。

#### KV Cache effect

在插件配置不变且已挂载时，工具结构前缀保持稳定。挂载、卸载或修改工具定义会替换该前缀并可能使缓存复用失效；凭据轮换和每次调用的用户断言不会改变该前缀。

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **身份密钥保管** — 动态断言要求将 Frappe 站点身份签名密钥放入受保护的 Harness 凭据库，并与站点身份配置一起轮换。`actorTokenRef` 仅保留给已经能够在每次调用签发新断言的受信任提供方；不支持静态长期用户令牌。
- **Native 模式只读** — 规则草稿、提交、发布和回滚会在本地被拒绝；写操作应使用 MCP 兼容模式或 Frappe 界面。
- **Native 账号保管** — 固定的 `frappeUser` 由部署管理，只应授予三类查询所需角色，不能由模型调用覆盖。
- **Frappe 结果边界** — 规则列表和试算结果的分页及载荷限制由服务端负责。本插件保留结构化结果，不另行设置第二套截断策略。

<a id="dev-note"></a>
### 开发备注

无。
