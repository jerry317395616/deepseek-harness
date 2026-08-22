import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mapSearxngResponse,
  mapSearxngResult,
  SearxngSearchProvider,
} from '@deepseek-ai/dsh-web-search-searxng'

const provider = (baseURL = 'https://search.example.test/root') =>
  new SearxngSearchProvider(() => ({ baseURL }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SearxngSearchProvider', () => {
  it('reports availability only for absolute HTTP(S) endpoints', () => {
    expect(provider().available()).toBe(true)
    expect(provider('http://127.0.0.1:8088').available()).toBe(true)
    expect(provider('file:///tmp/search').available()).toBe(false)
    expect(provider('not a url').available()).toBe(false)
  })

  it('maps citeable fields, drops malformed URLs, and deduplicates by URL', () => {
    expect(mapSearxngResult({
      url: 'https://a.test/article',
      title: '  Title  ',
      content: '  Summary  ',
      publishedDate: '  2026-08-22  ',
    })).toEqual({
      url: 'https://a.test/article',
      title: 'Title',
      snippet: 'Summary',
      publishedAt: '2026-08-22',
    })
    expect(mapSearxngResult({ url: 'javascript:alert(1)' })).toBeUndefined()
    expect(mapSearxngResult({ url: 42 })).toBeUndefined()
    expect(mapSearxngResponse({
      results: [
        { url: 'https://a.test/article', title: 'A' },
        { url: 'https://a.test/article', title: 'duplicate' },
        { url: 'https://b.test/article', title: 7, content: '' },
        { url: 'https://c.test/article', title: '', content: 7, publishedDate: '' },
        { url: 'https://d.test/article', publishedDate: 7 },
        { url: 'ftp://invalid.test/article' },
        'not an object',
        null,
      ],
    })).toEqual({
      sources: [
        { url: 'https://a.test/article', title: 'A' },
        { url: 'https://b.test/article' },
        { url: 'https://c.test/article' },
        { url: 'https://d.test/article' },
      ],
      truncated: false,
    })
  })

  it('uses the current endpoint for every search and sends the SearXNG JSON request', async () => {
    let baseURL = 'https://first.test/root'
    const search = new SearxngSearchProvider(() => ({ baseURL }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))

    const abort = new AbortController()
    await search.search({ query: '幼儿 营养' }, abort.signal)
    baseURL = 'https://second.test/api/'
    await search.search({ query: 'weekly menu' })

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://first.test/root/search?q=%E5%B9%BC%E5%84%BF+%E8%90%A5%E5%85%BB&format=json',
    )
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      'https://second.test/api/search?q=weekly+menu&format=json',
    )
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'ione-harness/1.0' },
      signal: abort.signal,
    })
  })

  it('maps provider, malformed-body, transport, and cancellation failures', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'engine unavailable' }), { status: 503 }))
    await expect(provider().search({ query: 'one' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'engine unavailable' })

    fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 502 }))
    await expect(provider().search({ query: 'two' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG API error (HTTP 502)' })

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'proxy unavailable' }), { status: 502 }))
    await expect(provider().search({ query: 'message error' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'proxy unavailable' })

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: '' }), { status: 500 }))
    await expect(provider().search({ query: 'empty error' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG API error (HTTP 500)' })

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.reject(new DOMException('cancelled', 'AbortError')),
    } as Response)
    await expect(provider().search({ query: 'error body cancelled' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ answers: [] }), { status: 200 }))
    await expect(provider().search({ query: 'three' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG returned no results array' })

    fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    await expect(provider().search({ query: 'invalid success body' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('unprocessable response body') })

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new DOMException('cancelled', 'AbortError')),
    } as Response)
    await expect(provider().search({ query: 'success body cancelled' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })

    fetchSpy.mockRejectedValueOnce(new Error('offline'))
    await expect(provider().search({ query: 'four' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    fetchSpy.mockRejectedValueOnce(new DOMException('network', 'NetworkError'))
    await expect(provider().search({ query: 'non-abort dom error' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    fetchSpy.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
    await expect(provider().search({ query: 'five' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})
