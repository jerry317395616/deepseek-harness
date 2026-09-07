---
description: "在 Native Bench Harness 部署中冻结 DocType 变更并禁止任意执行。"
---
# Native Bench 业务策略

[English](native-bench-business.md) | 中文

## Summary

普通对话使用已上线业务能力，不获得编程或结构修改权限。Host 策略拒绝任意脚本、源码编辑、元数据写入和迁移。现有查询及经批准的单值更新保留 Frappe 校验。这是能力限制，不是已完成的共享用户授权系统。

## Table of Contents

- [Deploy](#deploy)
- [Verify](#verify)
- [Boundaries and recovery](#boundaries-and-recovery)
- [Dev Note](#dev-note)

<a id="deploy"></a>
## Deploy

构建可信代码，并确保 Web 配置可解析源码插件及其策略子路径。保留现有模型及 Native Bench 提供方私有配置。最后应用[覆盖层](../../../apps/cli/config/examples/native-bench-business/cordis.yml)：

```sh
pnpm dsh web --patch ./apps/cli/config/examples/native-bench-business/cordis.yml --no-open --host 127.0.0.1 --port 13090
```

在 Harness 仓库运行，或将 `DSH_NATIVE_BENCH_BUSINESS_PRESET_ROOT` 指向运维拥有的预设目录。如果童健云目录不同于 `/home/zyd/frappe/native-bench/apps/tongjianyun`，设置 `DSH_NATIVE_BENCH_BUSINESS_WORKSPACE`。策略必须挂在整个 Host 上，不能作为用户自选插件。重启现有服务，替换已加载配置并关闭旧连接。

业务预设成为默认值。为兼容历史会话保留内置预设，但不能绕过全局拦截。Remote 配置、模型切换、预设编写及原生文件打开被拒绝。现有受控记录更新仍可回复审批，但不能覆盖禁止的工具。

<a id="verify"></a>
## Verify

```sh
pnpm exec vitest run packages/extensions/tool-native-bench-source/tests
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s packages/extensions/tool-native-bench-frappe/tests -p test_schema_freeze.py
DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/native-bench-business.snapshot.ts
```

录制测试使用模拟模型响应启动正式 Web CLI，验证聊天持久化、脚本拒绝、无编程工具结构及配置 RPC 拒绝。包测试覆盖强制放行后的拒绝、字段规划、迁移和间接元数据载体。测试不修改生产站点。

<a id="boundaries-and-recovery"></a>
## Boundaries and recovery

- 禁止所有 DocType 变更，包括 Custom Field、Property Setter、权限、命名、脚本、工作流元数据及间接迁移。
- 现有记录不是结构定义。允许的单值更新仍需预览、审批和部署 Frappe 用户权限。
- 此处尚未实现安全的界面和报表创建执行器；规划不代表执行。
- 共享登录身份绑定、会话归属和业务角色隔离需要单独部署。不要向不可信共享用户开放固定高权限桥接。
- Host 运维、直接访问 Frappe 的管理员及操作系统权限不属于本工具策略。配置和插件目录应由运维拥有。
- 启动失败时保持服务停止并修复受限覆盖层。移除覆盖层会重新开放权限，不能作为普通用户降级方案。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护说明</summary>

[包说明](../../../packages/extensions/tool-native-bench-source/README.zh.md)定义工具语义和剩余限制。不需要新增 DocType 或修改 Frappe 结构。

</details>
