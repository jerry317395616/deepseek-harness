---
description: "按权限读取 Native Bench Frappe 记录，或在维护运行时应用经过批准的标量字段修改。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-native-bench-frappe

[English](README.md) | 中文

## 概要

本包用于查看安全的 Frappe 元数据，并从当前 Native Bench 读取有权限访问的业务记录。维护运行时还可以预览并应用经过批准的现有记录标量字段修改。选择启用的业务运行时只接受限定范围的读取，并要求经过签名且明确绑定的用户身份。Frappe 权限仍是最终依据；本适配器不是多用户 Web 网关。

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
| `frappeUser` | 空 | 维护模式将空值解析为 Administrator；业务模式要求明确指定账号。 |
| `actorTokenFile` | 空 | 业务模式要求指向私有签名身份断言文件的绝对路径。 |
| `businessDoctypes` | 空 | 业务模式要求明确列出 1–64 个 DocType。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-native-bench-frappe)定义完整字段契约。维护模式会拒绝业务凭据和范围配置，不会静默忽略。

### 业务身份与读取

业务模式只注册描述、列表和单条读取。TypeScript 客户端与 Python 入口都会拒绝发现、修改和范围外的 DocType。Python 辅助程序读取仅文件所有者可访问、最多 4096 字节的 POSIX 普通身份断言文件；拒绝末级符号链接和硬链接。签名、站点、有效期和账号解析委托给 `ione_core.mcp.identity.resolve_actor_user`。验证所得账号必须与 `frappeUser` 完全一致，两种模式都要求账号为已启用的系统用户。

可信桥接层必须为每个隔离的用户运行时提供并刷新身份断言。本包不签发断言，也不将共享 Web 会话关联到用户。不要把共享维护主机作为员工部署：其他插件、Web API、会话和文件系统访问都需要单独隔离。

列表读取采用结构化筛选、单字段排序，最多返回 100 行并选择最多 64 个字段。单条读取使用相同的字段上限。受保护的基础设施 DocType 和敏感字段会被排除。身份失败返回固定诊断信息；工具参数、子进程参数和工具结果均不包含凭据内容。

### 经批准的维护修改

预览会检查现有记录及拟修改的标量字段，不会保存。执行要求完全一致的预览编号、文档版本和字段值，并通过 Harness 获得一次性批准。保存经过 Frappe 文档生命周期，因此校验、钩子和常规 Version 记录仍是最终依据。不提供新建、删除、提交、取消、子表和结构修改。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

[插件](src/index.ts)选择工具范围和审批策略。[客户端](src/native.ts)在启动 [Python 辅助程序](python/native_frappe_query.py)前检查部署范围。辅助程序在数据库启动前检查策略，在业务读取前验证操作者，并采用 Frappe ORM 权限，而不是任意 SQL 或模型提供的 Python。[Loader 测试](tests/loader-composition.spec.ts)、[无真实凭据的 Python 测试](tests/test_business_identity.py)和[拒绝操作会话记录](../../../snapshots/session/native-frappe-business-denial/session.jsonl)分别验证不同层的边界。

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

维护模式提供路由说明和六个工具 schema；业务模式提供限定读取的路由说明和三个 schema。结果包含有上限且经过脱敏的元数据或记录。配置的账号、站点路径、断言路径和可执行程序都不是模型调用参数。

#### Token 影响

路由说明在所选模式下固定不变。行数、字段数、输入和输出限制约束结果大小。

#### KV 缓存影响

改变挂载模式会改变系统提示和工具前缀。数据库内容不会改变提示词贡献。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

本适配器约束自身工具，不约束整个应用主机。

- **不是多用户网关** — 会话归属、登录交接、断言签发和续期由可信主机集成负责。
- **不提供班级归属策略** — DocType 允许列表不会将教师限制在一个班级内；Frappe 角色和记录权限必须单独执行该限制。
- **不是通用流程引擎** — 只有经过批准的维护标量修改可写；其他业务状态变更必须由领域服务负责。
- **不是主机级隔离** — 其他插件、Web API、附件和文件系统访问需要独立授权。不得在共享维护主机上启用业务模式。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
