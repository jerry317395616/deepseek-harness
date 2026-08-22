/**
 * SearXNG JSON search provider for the web capability.
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { SearxngErrorResponse, SearxngResult, SearxngSearchResponse } from './types.ts'

/** Stable id used by the web capability's provider selector. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Default local SearXNG HTTP origin for the iONE deployment. */
export const SEARXNG_DEFAULT_BASE_URL = 'http://127.0.0.1:8088'

/** Attribution header sent to the configured SearXNG instance. */
const USER_AGENT = 'ione-harness/1.0'

/** Resolved settings for one SearXNG search operation. */
export interface SearxngSearchProviderOptions {
  /** SearXNG origin; the provider appends `search?q=…&format=json`. */
  baseURL: string
}
/**
 * Convert one SearXNG result into a citeable source, excluding malformed URLs.
 *
 * @param result - one entry from SearXNG's JSON `results` array.
 * @returns a normalized source, or `undefined` when the URL is not HTTP(S).
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  if (typeof result.url !== 'string' || !isHttpUrl(result.url)) return undefined
  const title = typeof result.title === 'string' && result.title.trim().length > 0 ? result.title.trim() : undefined
  const snippet = typeof result.content === 'string' && result.content.trim().length > 0 ? result.content.trim() : undefined
  const publishedAt = typeof result.publishedDate === 'string' && result.publishedDate.trim().length > 0
    ? result.publishedDate.trim()
    : undefined
  return {
    url: result.url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
    ...publishedAt === undefined ? {} : { publishedAt },
  }
}

/**
 * Map and deduplicate SearXNG's JSON response into web capability sources.
 *
 * @param response - the parsed `GET /search?format=json` response body.
 * @returns normalized sources without duplicate URLs.
 * @throws {WebError} when the response does not contain a `results` array.
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  if (!Array.isArray(response.results)) {
    throw new WebError('SearXNG returned no results array', 'WEB_PROVIDER_ERROR')
  }
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const entry of response.results) {
    if (typeof entry !== 'object' || entry === null) continue
    const source = mapSearxngResult(entry as SearxngResult)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  return { sources, truncated: false }
}

/** SearXNG-backed `WebSearchProvider`; the configured service owns engines and policy. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  /**
   * @param resolveOptions - produces the current settings for each operation.
   */
  constructor(private readonly resolveOptions: () => SearxngSearchProviderOptions) {}

  /**
   * Determine whether the currently configured endpoint is usable.
   *
   * @returns `true` when the configured origin is an absolute HTTP(S) URL.
   */
  available(): boolean {
    return isHttpUrl(this.resolveOptions().baseURL)
  }

  /**
   * Execute one SearXNG JSON search and return citeable result fields.
   *
   * @param request - normalized web capability search request.
   * @param signal - optional cancellation signal forwarded to `fetch`.
   * @returns the normalized search result.
   * @throws {WebError} with `WEB_ABORTED` or `WEB_PROVIDER_ERROR` on failure.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const endpoint = new URL('search', normalizedBaseURL(options.baseURL))
    endpoint.searchParams.set('q', request.query)
    endpoint.searchParams.set('format', 'json')
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      const status = response.status
      let message = `SearXNG API error (HTTP ${status})`
      try {
        const detail = await response.json() as SearxngErrorResponse
        const candidate = typeof detail.error === 'string' ? detail.error : detail.message
        if (typeof candidate === 'string' && candidate.length > 0) message = candidate
      } catch (error: unknown) {
        if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }
    try {
      return mapSearxngResponse(await response.json() as SearxngSearchResponse)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      if (error instanceof WebError) throw error
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/**
 * Validate an absolute HTTP(S) URL.
 *
 * @param value - URL text to validate.
 * @returns whether the value is an absolute HTTP or HTTPS URL.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Ensure URL resolution appends a path rather than replacing the final segment.
 *
 * @param value - configured service origin.
 * @returns the origin with one trailing slash.
 */
function normalizedBaseURL(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

/**
 * Identify fetch's standard abort error.
 *
 * @param error - caught failure value.
 * @returns whether the value is a DOM abort error.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
