/** Package-owned invariant companion for the official Frappe documentation tools. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-frappe-docs'

/** Cordis companion plugin name. */
export const name = 'tool-frappe-docs-invariant'

/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the read-only helper validates its origin, operation,
// query, filter and output bounds at the process boundary.
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
