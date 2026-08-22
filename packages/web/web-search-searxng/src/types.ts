/**
 * SearXNG JSON search response fields used by this provider.
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One search entry returned by SearXNG's `format=json` endpoint. */
export interface SearxngResult {
  url?: unknown
  title?: unknown
  content?: unknown
  publishedDate?: unknown
}
/** SearXNG's JSON search response envelope. */
export interface SearxngSearchResponse {
  results?: unknown
}

/** Best-effort error response fields returned by SearXNG or its proxy. */
export interface SearxngErrorResponse {
  error?: unknown
  message?: unknown
}
