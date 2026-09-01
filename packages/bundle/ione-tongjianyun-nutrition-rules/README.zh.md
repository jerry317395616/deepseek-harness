# `@deepseek-ai/dsh-ione-tongjianyun-nutrition-rules`

[English](README.md) | 中文

这是一个可选 Bundle，用于把[童健云营养规则工具](../../extensions/tool-tongjianyun-nutrition-rules/README.zh.md)行插入 Harness Profile。该行默认禁用，因为当前 Bench 根目录、Frappe 站点和服务账号由具体部署决定。启用后默认使用本地模式，在 Bench 的 Frappe ORM 上直接执行只读查询，不经过 HTTP/MCP；需要规则变更时可显式选择经过认证的 MCP 兼容模式。

请在后续的 Profile 或主目录 `cordis.patch.yml` 中以完整配置启用它：

```yaml
- id: tongjianyun-nutrition-rules
  disabled: false
  config:
    transport: native
    benchRoot: /home/zyd/frappe/native-bench
    site: child.myyr.top
    frappeUser: Administrator
    timeoutMs: 30000
```

如需显式使用 MCP 兼容模式，请设置 `transport: mcp`、`endpoint` 和 `credentialRef`；凭据值必须保存于 Harness 凭据库。Native 模式支持标准解释、周食谱分析和规则列表三类只读调用；规则变更应使用 MCP 兼容模式或 Frappe 管理界面。

## 模型体验

### 可选的营养规则工具行

#### 模型可见内容

插入行保持禁用时，模型看不到任何新增内容。部署启用后，[童健云营养规则工具结构](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-tongjianyun-nutrition-rules)及其结构化结果会通过挂载的工具包进入模型可见范围。

#### Token 影响

Bundle 自身不增加提示词或工具结构。启用插入行后，会增加由工具包持有的八个固定工具结构、一个固定取证路由提示区段和普通工具结果载荷。

#### KV Cache 影响

禁用时没有影响。启用、禁用或调整插入的工具行会改变已挂载的工具结构前缀，可能使缓存复用失效。

## 已知限制与暂缓事项

- **必须提供部署配置** — Bundle 不能自行启用，因为当前 Bench 根目录、Frappe 站点和服务账号因部署而异。工具显示前，后续补丁必须提供完整配置。
- **Native 模式有意保持只读** — 本地模式会拒绝规则生命周期写操作，避免模型绕过经过审计的 Frappe 流程直接修改数据库。
