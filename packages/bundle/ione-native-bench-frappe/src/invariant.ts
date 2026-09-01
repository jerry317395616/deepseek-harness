/** Package-owned invariant companion for the Native Bench Frappe Bundle. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ione-native-bench-frappe'

/** Cordis companion plugin name. */
export const name = 'ione-native-bench-frappe-bundle-invariant'

/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: this package carries a static Loader patch only.
const install: InvariantInstaller = () => {}

/** Register the Bundle invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
