/** Package-owned invariant companion for the Tongjianyun nutrition-rule Bundle. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ione-tongjianyun-nutrition-rules'

/** Cordis companion plugin name. */
export const name = 'ione-tongjianyun-nutrition-rules-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: this package carries a static Loader patch only; the inserted tool package owns behavior and invariants.
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
