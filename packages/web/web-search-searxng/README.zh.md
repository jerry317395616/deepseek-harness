# @deepseek-ai/dsh-web-search-searxng

用于 Harness `web` 能力 seam 的自建 SearXNG 搜索提供方。
它调用 SearXNG JSON 接口，不需要商业搜索 API 密钥。

```yaml
- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://172.18.112.42:8088
```

SearXNG 实例必须启用 `json` 搜索格式。提供方调用：
`GET /search?q=<query>&format=json`。
