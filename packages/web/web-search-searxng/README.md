# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

`dsh-web-search-searxng` registers a SearXNG JSON `WebSearchProvider` in `ctx.web`. It sends `GET /search?q=…&format=json` to the configured SearXNG origin and maps result URLs, titles, snippets, and publication dates into the common web-search result format.

## Config

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8088` | SearXNG origin. The provider appends `/search?q=…&format=json`. |

```yaml
- id: web
  config:
    searchProvider: searxng

- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://127.0.0.1:8088
```

The provider rejects redirects and treats malformed results or non-success responses as `WEB_PROVIDER_ERROR`. A cancelled request returns `WEB_ABORTED`. The web capability enforces each tool request's result bound after the provider returns.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains only the requested number of SearXNG result URLs, titles, snippets, and publication dates while provider-private response fields remain outside model context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- SearXNG controls result count and engine selection in its own deployment configuration; this provider sends the query and JSON format only.
