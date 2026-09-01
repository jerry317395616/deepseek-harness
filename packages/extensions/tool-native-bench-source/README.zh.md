# `@deepseek-ai/dsh-tool-native-bench-source`

[English](README.md) | 中文

本包为当前实际提供站点服务的 Frappe Bench 注册只读工具。部署会明确固定 Native Bench 根目录，因此源码检索不依赖 Harness 进程的工作目录。工具通过有界操作搜索和读取 `apps/`、`sites/` 与 `config/`，不会暴露站点密钥、环境文件、日志或任意路径。

请在 Profile 或主目录补丁中配置：

```yaml
- id: native-bench-source
  name: '@deepseek-ai/dsh-tool-native-bench-source'
  config:
    benchRoot: /home/zyd/frappe/native-bench
    maxMatches: 200
    timeoutMs: 30000
```

`native_bench_search_code` 使用打包的 ripgrep，返回稳定路径、行号和有界预览。`native_bench_read_file` 从允许的源码或配置文件读取有限行窗口。`native_bench_runtime_status` 返回不含凭据的 Bench 安全清单。所有工具均为只读，不会修改 Bench 或 Frappe 站点。

## Model Experience

### Native Bench 源码工具

#### What the model sees

三个工具结构列在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-native-bench-source)中。固定路由区段要求模型先搜索 `/home/zyd/frappe/native-bench/apps`，再读取源码上下文或解释当前 Frappe 数据。

#### Token effect

插件挂载期间，每次请求均带有一个固定路由区段和三个工具结构。搜索和读取结果只追加工具返回的有界路径、行窗口和预览。

#### KV Cache effect

插件配置不变时，路由区段和工具结构前缀保持稳定。挂载、卸载或修改工具定义会替换该提示前缀；源码文件或运行数据变化不会改变它。

## Known Limitations and Deferred Work

- **运行源码版本对应** — 部分部署中的 Native Bench 应用目录没有 Git 修订号。因此工具会标明配置根目录并返回源码路径；历史版本对比仍需要独立的发布清单或文件哈希。
- **数据库操作由独立包处理** — 本包不会执行 SQL，也不会直接读取 Frappe 文档。童健云营养包通过单独的有界本地 Frappe 适配器读取受权限控制的证据；MCP 仍可作为网络部署的显式兼容模式。
