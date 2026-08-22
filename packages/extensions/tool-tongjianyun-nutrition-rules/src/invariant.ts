/** Package-owned invariant companion for the Tongjianyun nutrition-rule tool plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules'

/** Cordis companion plugin name. */
export const name = 'tool-tongjianyun-nutrition-rules-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: Frappe owns permissions, audit, rule state transitions, and confirmation validation.
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
