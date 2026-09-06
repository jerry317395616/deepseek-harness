---
description: "通过可选 Web 组合评估隔离的 Frappe 员工只读业务对话。"
---

# 员工只读预览

[English](employee-readonly.md) | 中文

## 概要

员工只读覆盖配置让运维人员能够评估不含编程工具的 Frappe 业务对话。每名员工都需要独立的 Web 进程、私有状态目录，以及由部署固定的已签名 Frappe 身份。模型可以查看允许的文档类型说明、查询列表和读取记录。这是经过 API 测试的部署预览，不是多用户服务器，也不是已完成的员工登录界面。

## 目录

- [评估预览](#evaluate-the-preview)
- [部署前提](#deployment-requirements)
- [边界与恢复](#boundaries-and-recovery)
- [开发备注](#dev-note)

-----

<a id="evaluate-the-preview"></a>
## 评估预览

将[员工覆盖配置](../../../apps/cli/config/examples/employee-readonly/cordis.yml)用于干净的标准 Web profile。相邻的[预设](../../../apps/cli/config/examples/employee-readonly/presets/employee-readonly/agent.cordis.yml)提供完整的业务角色提示和三项读取工具。不要将此配置与运维编程或维护补丁混用。

下面的已构建源码验收命令会启动私有临时 Web 进程，并使用模拟模型响应。它们不访问生产 Frappe 站点，也不需要模型凭据。运行前必须已经具备构建产物。

```sh
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.expected.config.ts apps/cli/tests/profiles/employee-readonly
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/employee-readonly.snapshot.ts scripts/session-snapshot-corpus.corpus.ts
```

测试通过说明 HTTP 和 WebSocket 越权操作遭到拒绝、Shell 工具不可用、两个 Host 的凭据与会话相互分离，并且会话可以持久化恢复。录制会话测试会固定完整模型提示、工具模式和拒绝调用的会话记录。

-----

<a id="deployment-requirements"></a>
## 部署前提

正式试用前，运维人员必须准备以下配置。测试夹具通过本地依赖构建环境，不从软件仓库下载；它不是员工账号安装器。

| 输入 | 必须具备的归属与约束 |
|---|---|
| Web profile 和已安装软件包 | 运维管理的标准 base/Web 层，能够解析 Native Bench Frappe 和 persona 插件；员工不能修改补丁 |
| 私有状态 | 每名员工拥有独立进程、工作目录、`DSH_HOME`、`DSH_AGENTS_HOME`、持久化根目录和浏览器凭据 |
| `DSH_EMPLOYEE_PRESET_ROOT` | 此覆盖配置相邻 `presets` 目录的绝对路径，由运维管理；不包含其他预设根目录 |
| `DSH_EMPLOYEE_BENCH_ROOT`、`DSH_EMPLOYEE_SITE` | 明确指定的 Native Bench 目录和目标站点 |
| `DSH_EMPLOYEE_USER`、`DSH_EMPLOYEE_ASSERTION_FILE` | 固定 Frappe 用户与私有、短时效的签名身份凭证；在对话之外维护续签 |
| `DSH_EMPLOYEE_DOCTYPES` | 明确批准的现有 DocType 名称 JSON 数组；空数组不授予任何文档访问权限 |
| 模型和网络 | 运维控制的模型提供方配置、回环地址监听，以及远程开放前经过认证的员工到 Host 代理 |

按照[真实进程夹具](../../../apps/cli/tests/profiles/employee-readonly/harness.ts)的调用方式，在 Web 应用参数之前通过启动器的 `--patch` 参数传入覆盖配置。签名材料、身份凭证内容和浏览器启动凭据不得进入提示词、向其他员工分享的 URL、日志或 Git。

-----

<a id="boundaries-and-recovery"></a>
## 边界与恢复

Gateway 仅允许明确列出的对话与只读发现接口。预设编辑和切换、配置修改、工作目录打开、附件、模型切换与会话分叉均被拒绝。模型不具备 Shell、文件系统、代码、命令、子代理、工作流或维护工具。源码配置仍是受信任的可执行代码，不是调用方可控制的权限设置。

身份凭证过期或 Frappe 权限拒绝时，必须向运维报告；助手不得更换身份或退回无限制接口。DocType 源码名称及 Frappe 授权仍是事实依据。此覆盖配置不创建 DocType，也不修改业务记录或角色权限。

独立进程和目录提供应用层隔离，不是共享同一 Unix 账号进程之间的操作系统沙箱。允许的事件流覆盖整个私有 Host。代理路由、员工登录、活动 WebSocket 撤销、真实账号的行级权限以及模型提供方的数据处理仍需部署验收。不能将不同员工接入同一个 Host 后称为已经隔离。

标准 Web 外壳可能仍保留被此配置禁止操作的控件。自动检查覆盖 HTTP、WebSocket、模型请求与持久化，不代表完整的视觉操作流程或真实员工 SSO 登录。运维人员必须在发布员工入口前完成浏览器和真实账号验收。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作背景</summary>

无。

</details>
