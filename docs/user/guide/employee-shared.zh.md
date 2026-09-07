---
description: "在一个共享 Harness 进程中验证账号所属会话，不开放员工 Agent 执行。"
---

# 共享员工会话预览

[English](employee-shared.md) | 中文

## 概要

此可选叠加配置允许多个经过验证的 Frappe 账号在同一个 Harness 进程中创建会话、查看自己的列表和分页历史，并执行限定范围的 Frappe 读取。它是 API 预览，不是共享聊天界面或正式部署。员工提示执行、模型工具、附件、搜索和全局事件流仍未开放。

## 验证预览

[共享叠加配置](../../../apps/cli/config/examples/employee-shared/cordis.yml)在干净的原生 Web 配置方案上，接在已有[只读组合](employee-readonly.zh.md)之后。[真实进程夹具](../../../apps/cli/tests/profiles/employee-readonly/employee-shared.expected.e2e.ts)提供临时目录和合成身份，为两个账号启动一个 Web 进程，并验证重启恢复。它不读取或修改线上 Frappe 站点。

使用 Linux、Python 3.14 和已构建的代码。可用 `DSH_SHARED_IDENTITY_PYTHON` 选择测试身份服务的解释器，否则使用 `python3`。

```sh
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.expected.config.ts apps/cli/tests/profiles/employee-readonly/employee-shared.expected.e2e.ts
DSH_EXAMPLE_MODE=lib DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/employee-readonly.snapshot.ts
```

会话回放测试使用可信 Host 测试驱动，在独立的无员工归属会话中回放专用只读角色。测试还向员工所属会话提交相同输入，验证没有启动模型步骤。员工不能调用 Host 提示接口。身份和登录凭据均不进入模型转录；此叠加配置不改变模型提示、工具 schema 或事件契约。

## 身份与会话归属

[身份服务](../../../packages/extensions/tool-native-bench-frappe/python/shared_identity.py)是独立的可信辅助进程，不是另一个 Harness 实例。它验证 Frappe 签发的一次性交接票据，并通过已有 Native Bench 只检查辅助程序复查当前已启用的系统用户。允许列表引用已有的逐账号身份配置。未知账号被拒绝，不会自动允许站点全部用户进入。

身份服务通过私有 Unix 套接字，只接受内核确认的指定运行时 UID。默认 `separate` UID 策略拒绝将 root、身份服务 UID 或 Bench 所有者 UID 用作运行时身份。显式 `single-user` 策略要求运行时、身份服务及每个 Bench 所有者使用同一个非 root UID。协议返回经过验证的 `{site,user}` 主体和不透明登录 Cookie，不返回签名密钥或 Bench 凭据。请求不能自行指定用户或所有者。

单账号模式提供应用层账号区分，不提供操作系统隔离：以同一 UID 运行的不受限进程可以访问相同的私有文件。不得向员工开放 shell、任意文件访问、配置编辑或 Host 凭据。此选项不授权员工 Agent 执行或业务写入。

[会话 API](../../../packages/api/session-controller/src/employee-access.ts)分配随机会话编号，在创建前发布不可变的归属记录，并在确认成功前持久化该会话。归属文件保存在模型日志之外的私有规范化目录。创建失败可能留下归属预留记录；列表只返回实际存在且属于当前账号的会话。没有归属的旧会话会被拒绝，不会分配给下一位访问者。

即使通过可信 Host API 提交，预览也会阻止员工所属 Agent 步骤和模型请求。不可被允许规则覆盖的工具检查还会拒绝员工所属及无 Agent 身份的工具调用。启动时先加载有数量上限的归属索引，再挂载路由；新预留在异步发布前进入索引。操作者不得在服务运行时编辑归属文件。无员工归属的 Host 会话保留现有执行策略，员工 Cookie 不能访问这些会话。已认证读取使用专用读取接口，不经过 Agent 工具运行时。

| 接口 | 允许的行为 |
|---|---|
| `GET /employee/sso?token=…` | 将一次签名交接票据换成带 Secure、HttpOnly、SameSite=Strict 属性的 Cookie，并跳转到状态页 |
| `GET /employee/status` | 复查登录状态并报告 `access: read-preview`、`agentExecution: false` |
| `POST /employee/logout` | 撤销登录并使 Cookie 过期 |
| `POST /employee/session/create` | 只接受 `{}`，创建由服务端指定归属的会话 |
| `POST /employee/session/list` | 只接受 `{}`，返回当前账号有大小上限的会话元数据 |
| `POST /employee/session/page` | 先检查会话归属，再读取有上限的历史页 |
| `POST /employee/session/read` | 接受 `sessionId`、允许的读取 `operation` 和结构化 `arguments`；要求会话归属及当前 Frappe 权限 |

Host 和写请求的 Origin 必须匹配指定 HTTPS 源。重复 Cookie、未知字段及不支持的操作被拒绝。结果返回前再次认证。退出、账号停用、依赖失败或过期会拒绝后续访问；身份服务重启会清空登录。超时、断开连接及插件销毁会取消并等待本地请求任务，但不能撤回已接受的会话创建，也不能立即取消已接受的远程读取。远程读取受身份服务的期限约束；服务关闭时取消并等待所属工作进程。

读取接口只接受 `frappe_describe_doctype`、`frappe_list_documents` 和 `frappe_get_document`。身份服务将不透明登录解析到固定的账号配置，校验明确的 DocType 范围，再使用该账号的私有身份断言调用已有业务读取程序。它不按共享运行时 UID 授权，也不接受用户、站点、可执行文件、权限绕过或写入参数。已有读取程序校验签名账号，使用 Frappe 权限与 `get_list`；此层不自行增加班级访问策略。

每个账号同时只运行一次读取。查询在线路上不超过 8192 字节，响应不超过 262144 字节；API 若配置了更小的响应上限，也同时生效。读取期间撤销登录会丢弃结果，新登录不能恢复旧请求。结果返回给已认证的 API 调用者，不追加到模型历史。此接口不是 Agent 工具，也不是具备完整审计的 AI 执行路径。

## 明确配置

叠加配置读取 `DSH_SHARED_PUBLIC_ORIGIN`、`DSH_SHARED_IDENTITY_SOCKET` 和 `DSH_SHARED_OWNERS_DIRECTORY`。其源码固定请求数、扫描数、响应大小及期限上限。[插件 Config](../../../packages/api/session-controller/src/employee-access.ts)定义完整 API 契约；不得向员工开放配置或 Host 启动凭据。

身份服务通过 `--config` 指定由操作者拥有的私有 JSON 文件。`--check` 只验证配置，不开启监听。只接受以下精确字段：

| 字段 | 契约 |
|---|---|
| `version`, `socket_path`, `runtime_uid` | 版本 1、受保护且规范化的 Linux 套接字位置、一个非 root 运行时 UID |
| `uid_policy` | 可选 `separate`（默认）或显式 `single-user`；单账号模式拒绝混合所有权 |
| `issuer`, `secret_file`, `identity_configs` | 精确站点、私有签名密钥文件、1–256 份已有账号检查配置 |
| `session_seconds`, `max_sessions` | 60–28800 秒、1–4096 个同时有效的登录 |
| `max_connections`, `timeout_seconds` | 1–64 条连接、每次操作 1–30 秒 |
| `read_doctypes` | 必填列表，包含 0–64 个不重复的安全 DocType；空列表禁用全部业务读取 |

读取还要求每个账号已有有效的身份断言。可信部署负责[断言续期](../../../packages/extensions/tool-native-bench-frappe/README.zh.md#native-bench-assertion-renewal)；共享 API 不开放续期或断言文件。单账号模式无法阻止同一 UID 下的不受限代码访问这些文件。断言缺失或过期时拒绝访问。无密钥夹具仅替换账号状态及业务查询结果；真实 Frappe 权限与浏览器验收仍属于部署工作。

## 正式开放前

已有 Frappe 入口指向 `/sso`，本预览使用 `/employee/sso`。此变更不安装正式路由、共享员工界面或真实浏览器及 TLS 单点登录验收。普通 Host Cookie 仍可授权高权限 Host API；员工 Cookie 不具备该能力。不得将 Host 启动地址分发给共享员工。

按 UID 绑定的只读业务代理仍将一个 UID 映射到一名员工，不能为共享进程内的不同员工授权。共享身份服务为每次读取独立选择账号。开放提示执行前，必须将每个排队的 Agent 轮次绑定到经过验证的调用者，在不把凭据放入模型输入的前提下连接读取桥接层，并记录实际工具调用及结果。写入需要独立的业务服务、流程检查和审批。不得接受模型指定的执行身份或回退到 Administrator。

需要在操作系统层隔离 Bench 所有权和签名材料时，应使用不同 UID。两种策略都必须保护直连端口及所有未按账号授权的 API，对代理日志中的票据查询脱敏，并验证负载下的资源上限。本预览不改变 Frappe DocType、业务记录、账号权限或正式服务。

## 开发备注

[决策记录](../../../.agents/notes/implemented/architecture/2026-09-07-shared-session-ownership.zh.md)说明此预览为何尚不能替代独立员工执行。
