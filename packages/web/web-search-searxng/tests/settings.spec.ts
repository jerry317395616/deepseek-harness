import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as searxngPlugin from '@deepseek-ai/dsh-web-search-searxng'
import { WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-searxng'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: 'searxng' })
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(searxngPlugin, { baseURL: 'https://entry.test/root' })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

async function searchOnce(ctx: Context): Promise<string> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ results: [] }), { status: 200 }),
  )
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  return String(fetchSpy.mock.calls.at(-1)?.[0] ?? '')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('web-search-searxng settings composition', () => {
  it('uses the local SearXNG default when composition omits the endpoint', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'searxng' })
    searxngPlugin.apply(ctx, {})

    expect(await searchOnce(ctx)).toContain('http://127.0.0.1:8088/search')
    await ctx.fiber.dispose()
  })

  it('applies a stored endpoint to the next real web-capability search', async () => {
    const bench = await boot()
    expect(await searchOnce(bench.ctx)).toContain('https://entry.test/root/search')

    await bench.ctx.settings.update(WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, {
      baseURL: 'https://stored.test/api',
    })

    expect(await searchOnce(bench.ctx)).toContain('https://stored.test/api/search')
    await bench.ctx.fiber.dispose()
  })

  it('falls back to composition config when settings detach', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, {
      baseURL: 'https://stored.test/api',
    })
    await bench.settingsFiber.dispose()
    expect(await searchOnce(bench.ctx)).toContain('https://entry.test/root/search')

    await bench.ctx.fiber.dispose()
  })

  it('releases its settings namespace when the plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns)))
      .toContain('web-search-searxng')

    await bench.pluginFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns)))
      .not.toContain('web-search-searxng')
    await bench.ctx.fiber.dispose()
  })
})
