/**
 * Settings domain base plugin, browser half. Provides `ctx.settingsScope`, the
 * settings-namespace scope service every preference row binds its durable
 * section through, and owns the one `settings.describe` reader in the browser:
 * the describe mirror, whose invalidation subscriptions
 * (`settings/document-updated`, `connection/reset`) live here so every derived
 * surface refreshes from a single wire read. It depends on no `ui-*`
 * presentation package, so any feature that owns a preference can reach it:
 * the settings SHELL — the `sidebar.settings` occupant, its navigation, and
 * the chrome — lives in ui-settings-general, because a shell dependency on
 * ui-sidebar would close a reference cycle through ui-layout and ui-theme.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only pair supplying `$on` and its key face without dragging a build
// artifact into the Host graph (rationale beside the same pair in
// settings-scope.ts).
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import { SettingsSchemaService } from './schema.ts'
import { SettingsScopeBinder } from './settings-scope.ts'
import { SettingsDescribeMirror } from './settings-mirror.ts'

export type {
  SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps, SettingsOnboardingOwnerProps,
  SettingsPluginsTabOwnerProps, SettingsSectionOwnerProps, SettingsTriggerOwnerProps,
} from './contract/slots.ts'
export type { SettingsScopeController, SettingsScopeBinder } from './settings-scope.ts'
export type { SettingsSchemaService } from './schema.ts'
export type { SchemaNode } from './schema.ts'
export type { SettingsDescribeFace, SettingsDescribeView, SettingsMirrorSnapshot } from './settings-mirror.ts'

/**
 * Required services: the wire handle for the mirror's reads and the forwarded
 * settings invalidation the mirror refreshes on.
 */
export const inject = ['connection', 'remote']

/**
 * Select whether settings use the Host document or browser process memory.
 * iONE's public entry point is protected by its Frappe-authenticated reverse
 * proxy, which forwards trusted requests to the local Harness host. The
 * build-time opt-in keeps ordinary remote Harness deployments process-local.
 *
 * @param isLoopback - whether the browser connected directly to the Host.
 * @param trustedProxy - public build flag for an authenticated reverse proxy.
 * @returns the settings persistence boundary for this client.
 */
export function settingsPersistence(
  isLoopback: boolean,
  trustedProxy = process.env.DSH_CLIENT_IONE_TRUSTED_SETTINGS === '1',
): 'host' | 'memory' {
  return isLoopback || trustedProxy ? 'host' : 'memory'
}

/**
 * Provide the settings-namespace scope service over one shared describe
 * mirror, and keep that mirror fresh on the two signals that can move the
 * settings document: a document commit and a (re)connect.
 *
 * Constructing the service in this plugin's fiber keeps its traced methods
 * bound to each consuming plugin's context.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const schema = new SettingsSchemaService(ctx)
  const connection = ctx.get('connection') as ConnectionHandle
  const persistence = settingsPersistence(connection.isLoopback)
  const mirror = new SettingsDescribeMirror(
    connection.api,
    persistence,
  )
  ctx.effect(() => {
    const disposers = [
      (ctx.get('remote') as ClientContext['remote']).$on('settings/document-updated', () => { void mirror.load() }),
      ctx.on('connection/reset', () => { void mirror.load() }),
    ]
    // The first connection also emits connection/reset, so startup normally
    // costs two reads (budgeted in startup-rpc-budget.e2e.ts). The in-flight
    // fold does not merge them into one; it guarantees at most one pending
    // read at a time and that no invalidation arriving mid-read is lost.
    void mirror.ensure()
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings: describe mirror invalidations')
  new SettingsScopeBinder(ctx, { mirror, schema, persistence })
}
