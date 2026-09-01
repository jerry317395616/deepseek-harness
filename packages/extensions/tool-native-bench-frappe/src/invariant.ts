/** Package-owned invariant companion for Native Bench Frappe read tools. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-native-bench-frappe'

/** Cordis companion plugin name. */
export const name = 'tool-native-bench-frappe-invariant'

/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the Frappe bridge owns its operation, DocType, field,
// filter and output bounds at the helper boundary.
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
