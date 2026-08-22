# @deepseek-ai/dsh-web-search-searxng

Self-hosted SearXNG search provider for the Harness `web` capability seam.
It calls the SearXNG JSON endpoint and does not require a commercial search API key.

```yaml
- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://172.18.112.42:8088
```

The SearXNG instance must enable the `json` search format. The provider expects
`GET /search?q=<query>&format=json`.
