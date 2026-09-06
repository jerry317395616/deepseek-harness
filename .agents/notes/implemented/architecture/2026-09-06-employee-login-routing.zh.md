# Agent Note: 将员工登录分流到独立 Harness 主机

Status: implemented

[English](2026-09-06-employee-login-routing.md) | 中文

## 问题

已部署的 Frappe 登录入口会对员工身份签名，但共享的 Harness 启动凭据不能区分会话所有者。筛选会话列表无法为运行时的其他 HTTP API、WebSocket 流量、设置或工具提供授权。

## 决策

[员工网关辅助程序](../../../../packages/extensions/tool-native-bench-frappe/python/employee_gateway.py)将已验证身份分流到由部署方指定的单员工后端。它不能回退到维护主机、创建运行时或修改 Frappe 记录。独立私有主目录和启动凭据是配置要求，不代表具备操作系统隔离。

登录与防重放状态有数量上限，仅保存在进程内。票据在锁保护下只能接受一次，且必须在启动之后签发，因此重启无需新增数据库结构即可使之前的票据和 Cookie 失效。代理必须验证每个 HTTP 请求和 WebSocket 升级请求；已经建立的流需要单独撤销。

## 考虑过的替代方案

**在共享主机中筛选列表。** 会话列表只是一个入口，无法限制工具执行、设置修改或直接 API 请求。

**根据登录输入动态创建运行时。** 进程路径、可执行参数和插件组合属于高权限部署配置。明确预先配置的绑定可使这些内容不受交接票据控制。

**使用新增 Frappe DocType 持久化认证。** 当前项目禁止修改 DocType。短期交接票据、有上限的内存和启动后签发要求可在不改变应用结构的前提下，确保重启时默认拒绝访问，代价是需要重新登录。

## 影响

源码提供并测试的是分流组件，不是已部署的多用户服务。生产开放仍要求隔离的配置方案、经过验证的代理、Frappe 身份断言签发与续期、禁用维护能力以及活动连接撤销。[包 README](../../../../packages/extensions/tool-native-bench-frappe/README.zh.md#employee-login-routing-helper)定义运行要求。

无真实凭据的测试套件通过 HTTP 验证两个身份、并发重放、过期、重启、退出和无效绑定。[业务拒绝会话记录](../../../../snapshots/session/native-frappe-business-denial/session.jsonl)验证模型无法通过业务读取器枚举 User 记录或执行修改；它不测试生产登录。
