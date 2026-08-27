# Agent Note: 当前 Frappe 运行时的 Native Bench 源码证据

Status: implemented

[English](2026-08-27-native-bench-source-evidence.md) | 中文

## Problem

此前 Harness 在解释童健云行为时依赖进程工作区和通用文件系统工具。该工作区并不是当前运行的 Frappe Bench，因此源码证据可能来自 `/workspace`、归档 Bench 或不再为 `child.myyr.top` 提供服务的部署目录。数据库 MCP 调用也缺少一个可靠的源码事实来源来解释返回值。

## Decision

`@deepseek-ai/dsh-tool-native-bench-source` 为配置的 Native Bench 根目录注册有界只读工具。部署明确固定 `/home/zyd/frappe/native-bench`，只允许访问其 `apps/`、`sites/`、`config/`、`Procfile` 和 `patches.txt`，并使用打包的 ripgrep 搜索源码。本包还提供不含凭据的运行清单，包括默认站点、已安装应用和服务端口。系统提示区段要求模型先搜索 Native Bench 源码，再调用受权限控制的童健云营养 MCP 工具；证据不可用时必须说明，不能猜测。

`@deepseek-ai/dsh-ione-native-bench-source` Bundle 负责可选补丁入口。生产 Profile 使用有界配置启用该入口。营养包接受 Native Bench 根目录下生成的报告，同时保留现有认证公开下载目录和数据库权限边界。

## Consequences

- 营养计算问题可以把 `native-bench/apps` 的精确源码行与当前数据库规则、食谱数据结合起来。
- 源码工具不能读取任意主机路径、密钥、日志或数据库文件，也不会执行 SQL 或修改 Frappe。
- 如果当前 Bench 移动，只需更新一个明确的 `benchRoot` 配置并重启 Harness；进程工作目录不再作为应用源码证据。
- 由于应用目录不一定包含 Git 修订号，历史源码对比仍需要发布清单或文件哈希。

## Alternatives considered

- **继续依赖 `/workspace` 和通用文件搜索**——否决，因为它不能标识正在运行的 Bench，可能把过期或无关源码当作当前证据。
- **在源码包中直接增加 SQL 访问**——否决，因为数据库权限、审计行为和营养规则语义已经属于经过认证的童健云 Frappe MCP 包。
- **把 Native Bench 包放入所有默认 Profile**——否决，因为该包暴露部署专属主机路径，必须作为明确且可审计的可选功能启用。
