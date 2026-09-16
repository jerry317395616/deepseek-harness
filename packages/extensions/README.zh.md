---
description: "extensions 组地图：用于定义、运行与移除动态 Cordis 包的模型侧工具和双半 runner，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/extensions

[English](README.md) | 中文

## 概述

extensions 组让 agent（智能体）检查并修改实时 DSH 运行时，而不编辑仓库文件或配置。该组支持通过模型工具或浏览器面板定义、运行、更新、停止和移除动态 Cordis 包。包可以作用于 host、浏览器或两者，不可变版本支持受控更新。定义只存在于进程内存中，并在 DSH 重启时消失。按模型工具、host 执行、浏览器执行或浏览器控件选择对应的子包。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-cordis`](tool-cordis/README.zh.md) | 七个模型侧工具：检查实时运行时，定义、运行、停止并移除动态包 | 注册到 `ctx.tools` |
| [`cordis-host-runner`](cordis-host-runner/README.zh.md) | host 半：定义注册表、沙箱化的 host 半生命周期，以及用于应答浏览器查询的 inspect 注册表 | 提供 `ctx.dynamicCordisRunner` 与 `ctx.cordisInspect` |
| [`cordis-client-runner`](cordis-client-runner/README.zh.md) | 浏览器半：将浏览器半源码求值为运行中的插件，并应答运行请求 | client 面；提供浏览器侧 `ctx.dynamicCordisRunner` |
| [`ui-cordis`](ui-cordis/README.zh.md) | 浏览器面：全局面板、生命周期工具卡片与 `@pluginId` 输入源 | client 面；注册 slot |
| [`tool-tongjianyun-nutrition-rules/`](tool-tongjianyun-nutrition-rules/README.zh.md) | Native Bench 本地 Frappe 只读工具，以及用于童健云营养规则生命周期的显式已认证 MCP 兼容模式 | 注册到 `ctx.tools` |
| [`tool-native-bench-frappe/`](tool-native-bench-frappe/README.zh.md) | 当前 Native Bench 中允许 DocType 的受权限控制 Frappe ORM 只读访问 | 注册到 `ctx.tools` |
| [`tool-frappe-docs/`](tool-frappe-docs/README.zh.md) | 按版本检索本地同步的 Frappe 官方文档索引 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

[扩展子系统页面](../../docs/subsystems/extensions.zh.md)说明了本包组共用的生命周期、所有权边界与运行时界面。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

同步 Frappe 官方文档的检索边界记录在 [Frappe 文档知识库 Agent Note](../../.agents/notes/implemented/architecture/2026-09-02-frappe-docs-knowledge-base.zh.md) 中。

两个浏览器半包位于本组，而不是 `packages/client/` 下，因为它们分别是本子系统双半包的浏览器半；client 面经由 client program 编译它们，host program 只引用 host runner。

</details>
