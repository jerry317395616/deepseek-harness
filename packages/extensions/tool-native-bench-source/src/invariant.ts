/** Package-owned invariant companion for the Native Bench source tools. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-native-bench-source'

/** Cordis companion plugin name. */
export const name = 'tool-native-bench-source-invariant'

/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the source tools own their path allowlist and bounded output checks.
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
