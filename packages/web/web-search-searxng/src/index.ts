/**
 * `@deepseek-ai/dsh-web-search-searxng`: registers a self-hosted SearXNG
 * search provider with `ctx.web`.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  SearxngSearchProvider,
  SEARXNG_DEFAULT_BASE_URL,
} from './provider.ts'

export {
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
} from './provider.ts'
export type { SearxngSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

export interface Config {
  /** Base URL of the self-hosted SearXNG instance. */
  baseURL?: string
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
})

/** Register the SearXNG provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new SearxngSearchProvider({
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get('SEARXNG_BASE_URL')?.value
      ?? SEARXNG_DEFAULT_BASE_URL,
  }))
}
