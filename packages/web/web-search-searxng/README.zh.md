# @deepseek-ai/dsh-web-search-searxng

[English](README.md) | 中文

`dsh-web-search-searxng` 向 `ctx.web` 注册 SearXNG JSON 搜索提供方。它向配置的 SearXNG 地址发送 `GET /search?q=…&format=json`，并将结果中的网址、标题、摘要和发布日期映射为统一的网页搜索结果。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8088` | SearXNG 地址；提供方自动追加 `/search?q=…&format=json`。 |

```yaml
- id: web
  config:
    searchProvider: searxng

- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://127.0.0.1:8088
```

提供方拒绝自动跳转，并将格式错误的结果或非成功响应作为 `WEB_PROVIDER_ERROR` 返回；取消的请求返回 `WEB_ABORTED`。网页能力层会在提供方返回后执行每次工具请求的结果数量限制。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具只保留请求数量范围内的 SearXNG 结果网址、标题、摘要和发布日期，提供方私有响应字段不会进入模型上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与后续工作

- 结果数量和搜索引擎选择由 SearXNG 部署配置控制；该提供方只发送查询与 JSON 格式参数。
