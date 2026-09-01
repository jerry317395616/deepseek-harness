---
description: "extensions 组地图：用于定义、运行与移除动态 Cordis 包的模型侧工具和双半 runner，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/extensions

[English](README.md) | 中文

## 概述

extensions 组让运行中的 agent 修改它自己所在的运行时：模型可以检查当前 DSH 进程里加载的插件与服务，定义动态 Cordis 包（可含 host 半、浏览器半或两者），运行、停止并彻底移除它，浏览器面板则操作全部定义。包按插件演进：一个插件持有若干不可变的包版本，可以在它们之间运行或更新。定义只存在于进程内存中，因此 DSH 重启即清空，本组不会写仓库文件，也不改任何配置。四个包构成整个子系统：模型侧工具加 host 半 runner，浏览器半 runner 加浏览器 UI。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.zh.md) | `cordis_inspect`／`cordis_define`／`cordis_run`／`cordis_stop`／`cordis_undefine` 工具：读取当前进程运行时，并在一个自有分组 fiber 下管理内存中的动态包 | 注册到 `ctx.tools` |
| [`tool-tongjianyun-nutrition-rules/`](tool-tongjianyun-nutrition-rules/README.zh.md) | Native Bench 本地 Frappe 只读工具，以及用于童健云营养规则生命周期的显式已认证 MCP 兼容模式 | 注册到 `ctx.tools` |
| [`tool-native-bench-frappe/`](tool-native-bench-frappe/README.zh.md) | 当前 Native Bench 中允许 DocType 的受权限控制 Frappe ORM 只读访问 | 注册到 `ctx.tools` |
| [`cordis-host-runner/`](cordis-host-runner/README.zh.md) | 定义注册表、host 半的 `node:vm` 沙箱，以及 request-run 往返 | 提供 `ctx.dynamicCordisRunner` |
| [`cordis-client-runner/`](cordis-client-runner/README.zh.md) | 双半包的浏览器半：把定义求值成活的浏览器插件，并应答运行请求 | client 面；提供浏览器侧 `ctx.dynamicCordisRunner` |
| [`ui-cordis/`](ui-cordis/README.zh.md) | 浏览器面：操作全部定义的全局面板，与只读的 define 卡片 | client 面；注册 slot |
