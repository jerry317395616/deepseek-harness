/**
 * Register the configured SearXNG JSON search provider in `ctx.web`.
 * @module @deepseek-ai/dsh-web-search-searxng
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import { SEARXNG_DEFAULT_BASE_URL, SearxngSearchProvider } from './provider.ts'
import type { SearxngSearchProviderOptions } from './provider.ts'

export {
  mapSearxngResponse,
  mapSearxngResult,
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
} from './provider.ts'
export type { SearxngSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web capability this provider contributes to. */
export const inject = ['web']

/** Deployment settings for the SearXNG origin. */
export interface Config {
  /** SearXNG origin; `/search?q=…&format=json` is appended by the provider. */
  baseURL?: string
}
export const Config: z<Config> = z.object({
  baseURL: z.string().default(SEARXNG_DEFAULT_BASE_URL),
})

/** Settings namespace shown in Harness's plugin configuration UI. */
export const WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE = settingsNamespace('web-search-searxng')

/**
 * Resolve one settings view into the next operation's provider options.
 *
 * @param config - current persisted plugin configuration.
 * @returns provider options for the next search operation.
 */
function resolveOptions(config: Config): SearxngSearchProviderOptions {
  return { baseURL: config.baseURL ?? SEARXNG_DEFAULT_BASE_URL }
}

/**
 * Register the SearXNG provider and make its origin editable through settings.
 *
 * @param ctx - Cordis context whose web capability receives the provider.
 * @param config - initial plugin configuration from the active profile.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new SearxngSearchProvider(() => resolveOptions(current())))
}
