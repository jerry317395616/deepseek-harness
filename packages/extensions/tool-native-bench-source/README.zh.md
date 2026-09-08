---
description: "查找运行中的 Native Bench 源码，禁止托管入口修改 DocType 或任意执行代码。"
kind: "package-reference"
---
# @deepseek-ai/dsh-tool-native-bench-source

[English](README.md) | 中文

## 概述

查找当前站点使用的 Frappe 源码。解析路由并规划童健云扩展，不编辑上游应用。可选 Host 策略禁止任意执行和所有 DocType 变更。数据库访问仍由独立的 Frappe 桥接负责。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

通过可信配置挂载插件。

### When to choose it

使用运行中的 Bench 源码作为证据。普通对话不能编辑代码、自定义结构或改变自身工具时，应用业务覆盖层；仅安装本包不会启用该策略。

### Minimal configuration

```yaml
- id: native-bench-source
  name: '@deepseek-ai/dsh-tool-native-bench-source'
  config:
    benchRoot: /home/zyd/frappe/native-bench

- id: native-bench-business-policy
  name: '@deepseek-ai/dsh-tool-native-bench-source/policy'
```

源码设置详见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-native-bench-source)。策略子路径不提供放宽配置。最后应用完整的[业务覆盖层](../../../docs/user/guide/native-bench-business.zh.md)，同时限制 Remote 方法和执行提供方。

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>内部实现——点击展开</summary>

有界读取和打包的 ripgrep 搜索返回源码证据，不暴露站点凭据。路由解析区分 Page、Report、Workspace 和 DocType。规划列出只读上游文件与童健云目标，但不编辑文件。字段规划和迁移被拒绝。维护入口保留经批准的资源构建和缓存清理；业务策略则完全禁止该工具。

Host 策略安装提前拒绝钩子和不可被放行覆盖的全局拦截器。审批不能覆盖拦截器拒绝，包括旧编程会话。仅允许名单内业务操作。Frappe 适配器单独拒绝结构及可执行元数据，包括直接适配器调用。

| 源码 | 职责 |
|---|---|
| [index.ts](src/index.ts) | 取证、路由规划、固定维护 |
| [policy.ts](src/policy.ts) | 托管准入策略 |
| [测试](tests/policy.spec.ts) | 拦截优先级及允许的操作 |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [业务覆盖层](../../../docs/user/guide/native-bench-business.zh.md)——部署。
- [Frappe 桥接](../tool-native-bench-frappe/README.zh.md)——记录权限。
- [Gateway](../../api/gateway/README.zh.md)——Remote 端点准入。

<a id="model-experience"></a>
## Model Experience

### Source evidence and business policy

#### What the model sees

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-native-bench-source)描述六个取证、规划和维护工具结构。策略声明“禁止任何 DocType 新增、修改或删除”。禁止调用即使获批也返回中文拒绝。缺少界面执行器时必须如实说明，不能声称已实现。

#### Token effect

提供方贡献工具结构和有界结果。策略加入固定指引；完整业务身份可替换提供方提示词部分，但保留限制。Web 录制固定实际组装的提示词和工具结构。

#### KV Cache effect

配置和预设变化会替换提示词前缀。源码内容和工具结果不会改变固定策略文本或结构。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

策略限制 Harness 工具，并非封锁管理员的一切通道。

- **可信 Host**——运维可更换插件或配置。文件权限与直接 HTTP 路由需要单独控制。
- **身份**——本包未实现共享登录身份绑定。更新保留部署身份、预览、审批及 Frappe 校验。
- **界面组合**——规划不等于提供安全的 Page、Workspace 或 Report 创建执行器。
- **历史会话**——旧编程预设可能显示会被全局拦截器拒绝执行的工具结构。
- **源码版本**——源码目录不是历史发布哈希。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明——点击展开</summary>

无需密钥的 native-bench-business Web 录制运行正式 CLI。Python 结构冻结测试不初始化真实站点。

</details>
