/** Search provider backed by a self-hosted SearXNG JSON endpoint. */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearxngSearchResponse, SearxngSearchResult } from './types.ts'

/** Stable id used by `dsh-web` provider selection. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Default local endpoint; deployments should override this for a remote instance. */
export const SEARXNG_DEFAULT_BASE_URL = 'http://127.0.0.1:8088'

export interface SearxngSearchProviderOptions {
  /** Base URL of the SearXNG instance, without `/search`. */
  baseURL: string
}

/** Map one SearXNG result to the Harness portable source shape. */
export function mapSearxngResult(result: SearxngSearchResult): WebSearchSource | undefined {
  if (result.url === undefined || !isHttpUrl(result.url)) return undefined
  const snippet = result.content?.trim()
  return {
    url: result.url,
    ...result.title?.trim() ? { title: result.title.trim() } : {},
    ...snippet ? { snippet } : {},
    ...result.publishedDate?.trim() ? { publishedAt: result.publishedDate.trim() } :
      result.published_date?.trim() ? { publishedAt: result.published_date.trim() } : {},
  }
}

/** A SearXNG-backed provider; no third-party API key is required. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    return isHttpUrl(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const endpoint = `${this.options.baseURL.replace(/\/+$/, '')}/search`
    const query = new URLSearchParams({
      q: request.query,
      format: 'json',
      categories: 'general',
      safesearch: '1',
      language: 'all',
    })

    let response: Response
    try {
      response = await fetch(`${endpoint}?${query.toString()}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'user-agent': 'deepseek-harness/0.1.0',
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).trim().slice(0, 300)
      } catch (error: unknown) {
        if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(
        `SearXNG search failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
        'WEB_PROVIDER_ERROR',
      )
    }

    try {
      const payload = await response.json() as SearxngSearchResponse
      const sources = (payload.results ?? [])
        .map(mapSearxngResult)
        .filter((source): source is WebSearchSource => source !== undefined)
      const answers = payload.answers?.filter(answer => answer.trim().length > 0).join('\n\n')
      return {
        ...answers ? { content: answers } : {},
        sources,
        truncated: false,
      }
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
