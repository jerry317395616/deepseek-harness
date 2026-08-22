/**
 * The web-search card's staged form over the SearXNG settings namespace.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the SearXNG search provider. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const WEB_SEARCH_NS = 'web-search-searxng'

/** The search-provider fields this card edits. */
export interface WebSearchSettings {
  /** SearXNG endpoint; blank inherits the deployment default. */
  baseURL?: string
}
/** What the web-search card renders. */
export interface WebSearchCardState extends CardShell {
  /** SearXNG endpoint. */
  baseURL: CardFieldState
}

/** The registration-side face the web-search card's slot entry injects. */
export interface WebSearchCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWebSearchCard. */
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
}

/** Bridges the `web-search-searxng` scope onto the card. */
export class WebSearchCardController {
  private readonly form: CardForm<WebSearchSettings>
  private readonly store: SnapshotStore<WebSearchCardState>

  /**
   * @param scope - the bound settings scope for the `web-search-searxng` namespace.
   */
  constructor(scope: SettingsScope<WebSearchSettings>) {
    this.form = new CardForm(scope, [textField('baseURL')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): WebSearchCardState {
    return {
      ...this.form.shell(),
      baseURL: this.form.field('baseURL'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): WebSearchCardFace {
    return { hooks: { webSearchCard: this.store }, ...this.form.actions() }
  }
}
