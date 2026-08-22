/** Wire types returned by the SearXNG JSON search API. */

export interface SearxngSearchResult {
  url?: string
  title?: string
  content?: string
  publishedDate?: string
  published_date?: string
}

export interface SearxngSearchResponse {
  query?: string
  results?: SearxngSearchResult[]
  answers?: string[]
}
