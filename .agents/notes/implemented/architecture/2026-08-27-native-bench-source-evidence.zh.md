# Agent Note: 当前 Frappe 运行时的 Native Bench 源码证据

Status: implemented

[English](2026-08-27-native-bench-source-evidence.md) | 中文

## Problem

此前 Harness 在解释童健云行为时依赖进程工作区和通用文件系统工具。该工作区并不是当前运行的 Frappe Bench，因此源码证据可能来自 `/workspace`、归档 Bench 或不再为 `child.myyr.top` 提供服务的部署目录。数据库 MCP 调用也缺少一个可靠的源码事实来源来解释返回值。

## Decision

`@deepseek-ai/dsh-tool-native-bench-source` 为配置的 Native Bench 根目录注册有界只读工具。部署明确固定 `/home/zyd/frappe/native-bench`，只允许访问其 `apps/`、`sites/`、`config/`、`Procfile` 和 `patches.txt`，并使用打包的 ripgrep 搜索源码。本包还提供不含凭据的运行清单，包括默认站点、已安装应用和服务端口。系统提示区段要求模型先搜索 Native Bench 源码，再调用受权限控制的童健云营养工具；证据不可用时必须说明，不能猜测。

`@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules` 现在默认使用本地只读 Frappe 适配器。有界 Python 辅助进程会在当前 Bench 中初始化配置站点，设置由部署固定的 Frappe 用户，并且只从 `tongjianyun.mcp_tools` 导入三个只读操作。TypeScript 和 Python 两层都会拒绝其他操作；不接受任意 SQL、Python 函数、站点路径或模型提供的用户。现有 HTTP MCP 传输只有在显式设置 `transport: mcp` 时才启用，主要用于经过审计的规则写操作。

`@deepseek-ai/dsh-tool-native-bench-frappe` 提供对应的通用 Frappe 平台桥接，可访问当前 Bench 中所有获准的 DocType，包括童健云之外的应用。它在部署固定用户的权限下提供已安装应用和 DocType 目录、安全字段元数据以及结构化列表／读取。现有业务记录还支持两步标量更新：预览会绑定文档版本和请求值，执行则要求 Harness 标准一次性审批、重新校验预览，并通过 Frappe 文档生命周期保存。辅助程序会拒绝基础设施、结构和凭据 DocType，对敏感字段脱敏，并且从不接受 SQL、Python、站点路径或模型提供的用户。由于 Bench 路径和站点属于部署配置，该 Bundle 仍保持显式启用。

`@deepseek-ai/dsh-ione-native-bench-source` Bundle 负责可选补丁入口。生产 Profile 使用有界配置启用该入口。营养包接受 Native Bench 根目录下生成的报告，同时保留现有认证公开下载目录和数据库权限边界。

## Consequences

- 营养计算问题可以在不经过 localhost 或公网 MCP 网络跳转的情况下，把 `native-bench/apps` 的精确源码行与当前数据库规则、食谱数据结合起来。
- 其他 Native Bench 应用的问题也可以把同样的源码证据与受权限控制的 Frappe ORM 读取结合起来，通用桥接不再局限于童健云。
- 源码工具不能读取任意主机路径、密钥、日志或数据库文件，也不会执行 SQL 或修改 Frappe。通用 Frappe 桥接只允许更新现有业务记录经过批准的标量字段；新建、删除、子表、工作流、结构、SQL 和 Python 操作仍不可用。营养适配器是独立的只读边界并带有固定操作白名单；规则写入仍必须走显式 MCP/UI 流程。
- 如果当前 Bench 移动，只需更新一个明确的 `benchRoot` 配置并重启 Harness；进程工作目录不再作为应用源码证据。
- 由于应用目录不一定包含 Git 修订号，历史源码对比仍需要发布清单或文件哈希。

## Alternatives considered

- **继续依赖 `/workspace` 和通用文件搜索**——否决，因为它不能标识正在运行的 Bench，可能把过期或无关源码当作当前证据。
- **在源码包中直接增加任意 SQL 或 Python 访问**——否决，因为数据库权限、校验、审计行为和业务语义属于 Frappe 应用。通用桥接只使用结构化元数据和 ORM 读取，以及预览／审批后文档保存流程；营养适配器只调用经过审计的业务函数。
- **把 Native Bench 包放入所有默认 Profile**——否决，因为该包暴露部署专属主机路径，必须作为明确且可审计的可选功能启用。
