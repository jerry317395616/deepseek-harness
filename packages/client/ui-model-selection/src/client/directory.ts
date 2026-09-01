/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 */
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection, ModelSelectionProjection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Public build flag limiting model selection to deployment-approved provider ids. */
const PROVIDER_ALLOWLIST = process.env.DSH_CLIENT_IONE_MODEL_PROVIDER_ALLOWLIST

/**
 * Parse the optional deployment provider allowlist.
 *
 * The flag is intentionally build-time and client-public: it controls only
 * which already-advertised routes an authenticated deployment exposes in its
 * model-selection surfaces. An absent or blank value preserves upstream DSH
 * behavior; a comma-separated value such as `qwen` narrows every shared
 * directory to those exact provider ids.
 *
 * @param value - comma-separated provider ids from the public build environment.
 * @returns normalized provider ids, or undefined when no restriction is configured.
 */
export function modelProviderAllowlist(
  value: string | undefined = PROVIDER_ALLOWLIST,
): ReadonlySet<string> | undefined {
  const providers = value?.split(',').map(provider => provider.trim()).filter(Boolean) ?? []
  return providers.length === 0 ? undefined : new Set(providers)
}

/**
 * Project a Host directory through the deployment provider allowlist.
 *
 * When a legacy session still points at a hidden provider, `routable` becomes
 * false even if that adapter remains loaded server-side. The composer is then
 * blocked until the user selects an approved advertised route, preventing a
 * hidden provider from remaining usable through stale session state.
 *
 * @param directory - fresh Host model directory.
 * @param allowlist - deployment-approved provider ids.
 * @returns the directory visible to both model-selection entries.
 */
export function visibleModelDirectory(
  directory: {
    current: ModelSelection
    routable: boolean
    groups: readonly ModelProviderGroup[]
    failures: readonly ModelCatalogFailure[]
  },
  allowlist: ReadonlySet<string> | undefined = modelProviderAllowlist(),
): typeof directory {
  if (allowlist === undefined) return directory
  const groups = directory.groups.filter(group => allowlist.has(group.id))
  return {
    ...directory,
    groups,
    failures: directory.failures.filter(failure => allowlist.has(failure.id)),
    routable: directory.routable && groups.some(group => group.id === directory.current.provider),
  }
}

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Effective selection: durable next-request projection, then Host default. */
  current: ModelSelection | null
  /**
   * Whether an adapter serves the current selection's provider, as the host reports
   * it — null before the first load, which is NOT the same as blocked. Read
   * this rather than "current matches no group": catalog membership is
   * advisory, so a route serving a model it stopped advertising is missing
   * from the groups yet perfectly usable.
   */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
  })

  /** Latest selection operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  private resolved = false
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeSelection: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param catalog - Host-generation catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   */
  constructor(
    private readonly sessions: Pick<TypertClientRemote['session'], 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly catalog: ModelCatalogDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
  ) {
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Refresh the advisory directory (both entries call this on open).
   * Failure preserves the last good groups and current selection.
   * @returns the fresh directory value.
   */
  /**
   * Ensure the Host generation's shared advisory catalog is loaded.
   * @returns the fresh directory value.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.load()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /**
   * Select the complete provider/model/reasoning selection. The durable
   * projection frame updates the shared current; failures surface on the store
   * and throw so each entry's own retry surface engages.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
 */
  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.error = null })
    const result = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return
    }
    if (!result.ok) {
      this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
    }
    this.store.update((s) => { s.status = 'ready'; s.error = null })
    this.syncInputs()
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeSelection()
    this.unsubscribeCatalog()
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {
      if (this.resolved) {
        if (catalog.status === 'error') {
          this.store.update((state) => {
            state.status = 'error'
            state.error = catalog.error
          })
        }
        return
      }
      this.store.set({
        current: null,
        routable: null,
        groups: [],
        failures: [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        error: catalog.error,
      })
      return
    }
    const current = projected.next ?? catalog.value.default
    const allowlist = modelProviderAllowlist()
    const groups = allowlist === undefined
      ? catalog.value.groups
      : catalog.value.groups.filter(group => allowlist.has(group.id))
    const failures = allowlist === undefined
      ? catalog.value.failures
      : catalog.value.failures.filter(failure => allowlist.has(failure.id))
    this.resolved = true
    this.store.set({
      current,
      routable: catalog.value.routableProviders.includes(current.provider)
        && (allowlist === undefined || groups.some(group => group.id === current.provider)),
      groups,
      failures,
      status: this.store.getSnapshot().status === 'selecting'
        ? 'selecting'
        : 'ready',
      error: null,
    })
  }
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}
