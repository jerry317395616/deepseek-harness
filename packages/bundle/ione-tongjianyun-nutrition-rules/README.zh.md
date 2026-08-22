# `@deepseek-ai/dsh-ione-tongjianyun-nutrition-rules`

[English](README.md) | 中文

这是一个可选 Bundle，用于把[童健云营养规则工具](../../extensions/tool-tongjianyun-nutrition-rules/README.zh.md)行插入 Harness Profile。该行默认禁用，因为 Frappe 接口地址和凭据引用由具体部署决定；安装 Bundle 不能猜测接口，也不能把密钥写进仓库。

请在后续的 Profile 或主目录 `cordis.patch.yml` 中以完整配置启用它：

```yaml
- id: tongjianyun-nutrition-rules
  disabled: false
  config:
    endpoint: https://child.myyr.top/api/method/ione_core.mcp.server.handle_mcp
    credentialRef: IONE_TONGJIANYUN_MCP_TOKEN
    actorTokenRef: IONE_TONGJIANYUN_ACTOR_TOKEN
    timeoutMs: 30000
```

引用的凭据值应保存于 Harness 凭据库，而不应写入补丁。不启用童健云当前用户断言校验时，可省略 `actorTokenRef`。

## 模型体验

### 可选的营养规则工具行

#### 模型可见内容

插入行保持禁用时，模型看不到任何新增内容。部署启用后，[童健云营养规则工具结构](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-tongjianyun-nutrition-rules)及其结构化结果会通过挂载的工具包进入模型可见范围。

#### Token 影响

Bundle 自身不增加提示词或工具结构。启用插入行后，会增加由工具包持有的六个固定工具结构和普通工具结果载荷。

#### KV Cache 影响

禁用时没有影响。启用、禁用或调整插入的工具行会改变已挂载的工具结构前缀，可能使缓存复用失效。

## 已知限制与暂缓事项

- **必须提供部署配置** — Bundle 不能自行启用，因为 Frappe MCP 地址和凭据引用因站点而异。工具显示前，后续补丁必须提供完整配置。
