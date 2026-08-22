/** Resolve shell-free child-process invocations for the pnpm process that launched a package script. */

/**
 * Resolve pnpm's executable and arguments from its lifecycle environment.
 * @param args - Arguments to pass to pnpm.
 * @param environment - Lifecycle environment containing `npm_execpath`.
 * @returns A command and argument array suitable for `spawn` or `spawnSync` without a shell.
 */
export function pnpmInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const entrypoint = environment.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('pnpm invocation: npm_execpath is unavailable; invoke the script through pnpm run.')
  }
  const offlineArgs = environment.DSH_PNPM_OFFLINE === '1' && args[0] === 'install'
    ? ['--offline', '--store-dir=/tmp/pnpm-store', '--trust-policy=off', '--trust-lockfile']
    : []
  if (/\.[cm]?js$/iu.test(entrypoint)) {
    return { command: process.execPath, args: [entrypoint, ...offlineArgs, ...args] }
  }
  return { command: entrypoint, args: [...offlineArgs, ...args] }
}
