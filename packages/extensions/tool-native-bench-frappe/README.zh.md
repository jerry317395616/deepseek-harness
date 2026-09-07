---
description: "按权限读取 Native Bench Frappe 记录，或在维护运行时应用经过批准的标量字段修改。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-native-bench-frappe

[English](README.md) | 中文

## 概要

本包用于查看安全的 Frappe 元数据，并从当前 Native Bench 读取有权限访问的业务记录。维护运行时还可以预览并应用经过批准的现有记录标量字段修改。选择启用的业务运行时只接受限定范围的读取，并要求经过签名且明确绑定的用户身份。Frappe 权限仍是最终依据。可选的本机登录辅助程序可将员工分流到预先配置的独立主机；它不会让共享主机具备安全的多用户能力。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过配置方案或 Bundle 补丁挂载本包。部署方负责 Bench 根目录、站点、可执行程序、账号和范围；模型调用不能提供这些配置。

### 维护配置

此配置保留发现、描述、列表与单条读取、修改预览以及经批准的修改执行：

```yaml
- id: native-bench-frappe
  name: '@deepseek-ai/dsh-tool-native-bench-frappe'
  config:
    accessMode: maintenance
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `accessMode` | `maintenance` | 业务模式只提供限定范围的描述、列表和单条读取操作。 |
| `frappeUser` | 空 | 直连业务调用要求明确账号；维护模式默认 Administrator；代理模式要求留空。 |
| `actorTokenFile` | 空 | 直连业务调用要求私有身份断言的绝对路径；代理模式要求留空。 |
| `brokerSocketPath` | 空 | 选择启用的 Linux Unix 套接字；要求业务模式且身份由代理管理。 |
| `businessDoctypes` | 空 | 业务模式要求明确列出 1–64 个 DocType。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-native-bench-frappe)定义完整字段契约。维护模式会拒绝业务凭据和范围配置，不会静默忽略。

### 业务身份与读取

业务模式只注册描述、列表和单条读取。TypeScript 客户端与 Python 入口都会拒绝发现、修改和范围外的 DocType。Python 辅助程序读取仅文件所有者可访问、最多 4096 字节的 POSIX 普通身份断言文件；拒绝末级符号链接和硬链接。签名、站点、有效期和账号解析委托给 `ione_core.mcp.identity.resolve_actor_user`。验证所得账号必须与 `frappeUser` 完全一致，两种模式都要求账号为已启用的系统用户。

可信桥接层必须为每个隔离的用户运行时提供并刷新身份断言。独立的 [Native Bench 续期程序](#native-bench-assertion-renewal)提供此部署操作；它不会将共享 Web 会话关联到用户。不要把共享维护主机作为员工部署：其他插件、Web API、会话和文件系统访问都需要单独隔离。

列表读取采用结构化筛选、单字段排序，最多返回 100 行并选择最多 64 个字段。单条读取使用相同的字段上限。受保护的基础设施 DocType 和敏感字段会被排除。身份失败返回固定诊断信息；工具参数、子进程参数和工具结果均不包含凭据内容。

<a id="employee-login-routing-helper"></a>
### 员工登录分流辅助程序

可选的 [Python 辅助程序](python/employee_gateway.py)接受已部署 Frappe 登录入口签发的交接格式。它不由 Cordis 插件挂载，也不会自动启动。其私有 JSON 配置必须包含以下字段；未知字段会导致启动失败：

| 字段 | 必填值 |
|---|---|
| `version` | `1` |
| `issuer` | 精确的签发站点主机名。 |
| `public_origin` | 用于退出验证的精确 HTTPS 源。 |
| `secret_file` | 保存登录签名密钥、仅所有者可访问的绝对文件路径。 |
| `port` | 明确指定的本机监听端口，1024–65535。 |
| `session_seconds` | 登录会话的绝对有效期，60–28800 秒。 |
| `max_sessions` | 有效登录会话上限，1–4096；防重放记录上限为此值的四倍。 |
| `bindings` | 1–256 个明确包含 `user`、`upstream`、`home`、`launch_file` 的对象。 |

每个绑定必须使用独立的 `http://127.0.0.1:port`、互不包含且仅所有者可访问的主目录，以及位于该目录内的独立私有启动凭据。拒绝 Guest 和 Administrator 绑定。配置在一次进程生命周期中保持不变。请求不能选择或覆盖后端地址。无效、过期、未来时间、重复使用或用户未绑定的交接票据返回 401；票据必须在进程启动之后签发，且有效期最长 60 秒。重启会使登录会话失效，并拒绝启动前签发的票据；应在启动后的第一个完整秒之后获取新票据。

反向代理必须将 `GET /auth` 设为内部接口，并且对**每个 HTTP 请求和 WebSocket 升级请求**，只使用该接口验证后返回的 `X-Harness-Upstream` 选择后端。`GET /sso?token=…` 将交接票据换成带 Secure、HttpOnly 属性的主机 Cookie，并跳转到对应员工的启动地址。同源 `POST /logout` 删除该登录会话。辅助程序不记录请求日志，并返回 no-store/no-referrer 响应头；部署代理也必须省略包含凭据的查询字符串。它不转发业务流量，也不保护被直接访问的运行时端口。

可选的[流量代理](python/employee_proxy.py)负责 HTTP 转发和活动 WebSocket 撤销。其独立私有配置只接受 `gateway_config`、`python`、`identity_configs`、`recheck_seconds` 和 `check_seconds`。`gateway_config` 指向上述分流配置；`python` 是 Bench 解释器的绝对路径；`identity_configs` 为每个绑定员工指定已有的私有续期配置，用户名与站点必须匹配该绑定。两个时间参数必须明确指定为正数秒，最大 30 秒。代理在装有[固定版本传输依赖](python/requirements-employee-proxy.txt)的独立 Python 环境运行，仅在执行可信续期程序的只读 `--check` 操作时调用 Bench 解释器。

代理在转发请求和返回 HTTP 数据之前、转发每条 WebSocket 数据消息之前，以及连接空闲时检查身份。退出、会话过期、账号停用或身份检查依赖失败会关闭连接两端；空闲连接的检测上限为复查间隔加检查超时，之后的关闭握手最多两秒。代理拒绝跨源写请求和 WebSocket 升级，隐藏 `/auth`，不接受调用方指定后端。HTTP 请求体上限为 1 MiB，响应体上限为 16 MiB；WebSocket 消息上限为 1 MiB。TLS 终止、禁止直接访问运行时端口、私有配置及代理日志脱敏仍由部署方负责。

[传输测试](tests/test_employee_proxy.py)覆盖撤销和清理。将 `DSH_EMPLOYEE_PROXY_PYTHON` 指向独立解释器后，[员工 Web 测试夹具](../../../apps/cli/tests/profiles/employee-readonly/proxy.ts)会通过临时代理身份驱动真实 Web 主机和已有会话回放。这是不使用真实凭据的传输验证，不代表线上 Frappe 单点登录或浏览器验收通过。断开客户端不会取消或回滚 Harness 已接受的工作。实例配置、线上单点登录接入和生产负载测试仍属于独立的部署工作。

限定站点的[线上验收程序](../../../scripts/employee-live-acceptance.py)默认只读预览。在指定 Native Bench 上，经授权的操作者核对预览后，可使用 `--run --expected-students N` 执行。它仅接受已有的两个停用测试账号，要求角色完全匹配且班级权限名单未变化，串行执行验收，临时启用账号，并通过 Frappe 密码服务重设测试密码。程序使用真实 HTTPS 登录、Frappe 签名交接票据、独立 Web 配置方案和本机脚本模型，验证记录权限与活动连接撤销。清理时停用账号并清除会话，核对业务记录及权限指纹，并在所属进程停止后删除私有运行目录。主机突然故障或 SIGKILL 可能阻止清理；操作者随后必须通过 Frappe 停用指定测试账号并清除会话。程序需要已构建的 Harness、Bench 解释器及单独安装的代理依赖；不修改正式路由，也不认证公网 TLS、浏览器 Cookie 行为、财务计算或针对恶意本机进程的隔离。

只读[部署预检程序](../../../scripts/employee-deployment-preflight.py)检查固定的 Child/Harness HTTPS 入口和本机 systemd 运行时，不登录、不读取响应正文、不收集凭据。在部署根目录运行 `native-bench/env/bin/python -B deepseek-harness/scripts/employee-deployment-preflight.py`；默认目标为用户服务 `ione-harness.service`，可通过明确的 `--unit` 和 `--scope user|system` 参数检查候选运行时。它报告经证书验证的登录跳转、进程身份分离、选定的沙箱设置和有限资源上限。观测缺失、变化或失败时不予通过。程序始终以退出码 2 结束并报告 `deployment_approved: false`：即使自动基线通过，仍需独立验收路由、登录后的浏览器行为、文件系统及凭据隔离、高权限辅助程序分离，以及故障和负载行为。它不安装或实施限制，不检查 nginx 路由，也不认证多用户部署。

<a id="employee-read-broker"></a>
### 员工只读业务代理后端

可选的 Linux [只读代理](python/employee_read_broker.py)将可信 Bench 读取进程与调用者分离，并通过 Unix 套接字的 `SO_PEERCRED` 识别调用者。私有配置将每个已存在且独立的 Linux UID 绑定到一份私有续期配置及 DocType 允许列表。拒绝 root、代理自身 UID、Bench 所有者 UID、重复员工和受保护的 DocType。部署方负责套接字的规范化目录及全部上级目录；这些目录不得允许组或其他用户写入，也不得属于无关用户。套接字权限为 0666；目录位置控制可达性，内核提供的 UID 绑定控制授权。

每条连接只接受一个以换行结束的 JSON 对象，随后调用方关闭写入方向：整数 `version: 1`、`operation` 和 `arguments`。仅接受 `frappe_describe_doctype`、`frappe_list_documents` 和 `frappe_get_document`。身份、路径、可执行程序和范围不是请求字段。代理以固定 Frappe 账号调用既有业务读取程序，再执行续期程序的身份检查，随后才返回结果。身份配置变化、检查失败、无效输入或结果超限均返回固定拒绝信息；不转发部署或工作进程诊断。

[配置解析器](python/employee_read_broker.py)要求明确的连接数、输入和输出上限、输入输出期限及每个工作进程的执行期限。每个 UID 同时只能执行一个请求；超限连接会关闭。工作进程使用最小环境变量集，输出大小受到限制。超时或取消会终止并回收仍在运行的工作进程；服务关闭时停止接收并等待所属任务结束。仅断开连接不会取消已接受的读取。[代理测试](tests/test_employee_read_broker.py)不使用生产数据，覆盖真实本机套接字、配置命令行、子进程限制和清理。

设置 `brokerSocketPath`，或在员工配置方案中设置 `DSH_EMPLOYEE_BROKER_SOCKET`，即可选择 [TypeScript 套接字客户端](src/broker.ts)。代理模式要求业务访问、明确的 DocType 允许列表，并将 `frappeUser` 和 `actorTokenFile` 留空。站点、身份、凭据和 Bench 可执行程序仅由代理管理；直连路径配置不参与调用。代理不可用或拒绝访问时直接失败，不会回退到 Bench 子进程。

客户端限制完整请求和响应的大小，拒绝无效 UTF-8/JSON，并返回固定诊断而不转发代理错误。期限覆盖连接建立至响应完成。取消会关闭并等待本地连接结束，不会取消服务端已接受的读取。[真实套接字客户端测试](tests/broker-client.spec.ts)覆盖这些行为。系统用户、受保护的文件系统访问、身份断言续期、服务启用和登录后的浏览器验收仍属于部署工作。

### 共享身份服务预览

可选的[共享身份服务](python/shared_identity.py)为一个独立的 Harness UID 验证允许列表中的多个 Frappe 账号。它将签名交接票据换成不透明登录，并以只检查模式复查已有 Native Bench 身份辅助程序。[共享会话指南](../../../docs/user/guide/employee-shared.zh.md)定义配置及独立的账号所属 API。此辅助程序不授予业务访问权限：上面的 UID 绑定只读代理仍只服务一名员工，不能用于一个共享运行时内的逐账号授权。共享 Agent 执行和正式单点登录路由仍待完成。

<a id="native-bench-assertion-renewal"></a>
### Native Bench 身份断言续期

可选的[续期程序](python/native_actor_refresh.py)使用当前 Bench 的 Python 环境运行，是可信部署进程，不是模型工具。`--config` 参数指向仅所有者可访问的 JSON 文件，且只接受以下字段：

| 字段 | 必填值 |
|---|---|
| `version` | 整数 `1`。 |
| `bench_root` | 包含目标站点、已规范化的 Native Bench 绝对目录。 |
| `site` | 精确的站点主机名。 |
| `user` | 精确的已启用系统用户名；拒绝 Guest 和 Administrator。 |
| `assertion_file` | 位于已规范化且仅所有者可访问目录内的绝对文件路径。 |
| `ttl_seconds` | 明确指定的整数有效期，60–900 秒。 |

续期程序通过 Frappe ORM 读取当前账号，在内部按已部署的 I-ONE 断言格式签名，并在发布前通过 `ione_core.mcp.identity.resolve_actor_user` 校验。它不输出签名材料或身份断言，不将凭据复制到模型配置中，也不提交业务记录。`--check` 只验证身份，不发布或撤销文件；成功时输出 `employee identity verified`。正常续期成功时输出 `employee assertion refreshed`；失败时以非零状态退出并输出 `employee assertion refresh failed`。

发布过程采用独占创建的私有临时文件、文件同步和原子重命名。拒绝已有符号链接、硬链接和公开可读的目标。安全打开目标目录后，续期失败会撤销旧断言。配置或打开失败，以及进程被终止时，旧断言可能保留至过期。部署调度器必须串行执行，并在有效期内续期；移除员工绑定时也必须停止续期。移除绑定不会自动删除已有断言文件。

签发程序需要对站点签名配置和数据库的本机特权访问。员工运行时不得控制该进程、其配置或签名材料。同一操作系统用户拥有的私有文件，不能隔离互不信任的进程。此程序不会修复共享主机授权策略，也不会开放员工 Web 访问。

### 经批准的维护修改

预览会检查现有记录及拟修改的标量字段，不会保存。执行要求完全一致的预览编号、文档版本和字段值，并通过 Harness 获得一次性批准。保存经过 Frappe 文档生命周期，因此校验、钩子和常规 Version 记录仍是最终依据。不提供新建、删除、提交、取消、子表和结构修改。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

[插件](src/index.ts)选择工具范围和审批策略。[客户端](src/native.ts)检查部署范围，再选择直接调用 [Python 辅助程序](python/native_frappe_query.py)或不持有凭据的套接字客户端。两种传输均保留辅助程序的身份及 Frappe ORM 权限校验，不使用任意 SQL 或模型提供的 Python。[Loader 测试](tests/loader-composition.spec.ts)、[无真实凭据的 Python 测试](tests/test_business_identity.py)和[拒绝操作会话记录](../../../snapshots/session/native-frappe-business-denial/session.jsonl)分别验证不同层的边界。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下文档分别负责相邻的集成边界。

- [Native Bench 源码工具](../tool-native-bench-source/README.zh.md) — 源码检查和扩展规划。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-native-bench-frappe) — 面向模型的参数契约。
- [测试策略](../../../docs/testing.zh.md) — 针对性测试和无密钥会话回放。

-----

<a id="model-experience"></a>
## 模型体验

### Native Bench Frappe 平台工具

#### 模型看到的内容

维护模式提供路由说明和六个工具 schema；业务模式提供限定读取的路由说明和三个 schema（如 `native_bench_frappe_get_document`）。登录分流辅助程序不提供模型工具。结果包含有上限且经过脱敏的元数据或记录。配置的账号、站点路径、断言路径和可执行程序都不是模型调用参数。

#### Token 影响

路由说明在所选模式下固定不变。行数、字段数、输入和输出限制约束结果大小。

#### KV 缓存影响

改变挂载模式会改变系统提示和工具前缀。数据库内容不会改变提示词贡献。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

本适配器约束自身工具，不约束整个应用主机。

- **不提供共享主机授权** — 登录辅助程序分流到独立主机，不在一个主机内区分会话所有者；实例配置和独立断言续期程序的调度仍属于部署工作。
- **不提供班级归属策略** — DocType 允许列表不会将教师限制在一个班级内；Frappe 角色和记录权限必须单独执行该限制。
- **不是通用流程引擎** — 只有经过批准的维护标量修改可写；其他业务状态变更必须由领域服务负责。
- **不是主机级隔离** — 其他插件、Web API、附件和文件系统访问需要独立授权。不得在共享维护主机上启用业务模式。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
