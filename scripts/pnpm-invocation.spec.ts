import { describe, expect, it } from 'vitest'
import { pnpmInvocation } from './pnpm-invocation.ts'

describe('pnpm invocation', () => {
  it.each([
    '/tools/pnpm.js',
    '/tools/pnpm.cjs',
    '/tools/pnpm.mjs',
    '/tools/PNPM.CJS',
    '/tools/with spaces/工具/$pnpm;.mjs',
  ])('runs the JavaScript entrypoint %j through Node', (entrypoint) => {
    expect(pnpmInvocation(['run', 'build'], { npm_execpath: entrypoint })).toEqual({
      command: process.execPath,
      args: [entrypoint, 'run', 'build'],
    })
  })

  it.each([
    '/tools/pnpm',
    '/tools/with spaces/$pnpm;',
    String.raw`C:\Program Files\工具\$pnpm;\pnpm.exe`,
  ])('runs the executable entrypoint %j directly', (entrypoint) => {
    expect(pnpmInvocation(['run', 'build'], { npm_execpath: entrypoint })).toEqual({
      command: entrypoint,
      args: ['run', 'build'],
    })
  })

  it.each([undefined, ''])('rejects an unavailable lifecycle entrypoint', (entrypoint) => {
    expect(() => pnpmInvocation([], { npm_execpath: entrypoint }))
      .toThrow('npm_execpath is unavailable; invoke the script through pnpm run')
  })

  it.each([
    ['/tools/pnpm.cjs', process.execPath, ['/tools/pnpm.cjs']],
    ['/tools/pnpm', '/tools/pnpm', []],
  ] as const)('adds the reproducible offline install flags for %s', (entrypoint, command, prefix) => {
    expect(pnpmInvocation(['install', '--frozen-lockfile'], {
      npm_execpath: entrypoint,
      DSH_PNPM_OFFLINE: '1',
    })).toEqual({
      command,
      args: [
        ...prefix,
        '--offline',
        '--store-dir=/tmp/pnpm-store',
        '--trust-policy=off',
        '--trust-lockfile',
        'install',
        '--frozen-lockfile',
      ],
    })
  })

  it('does not alter non-install commands in offline build mode', () => {
    expect(pnpmInvocation(['run', 'build'], {
      npm_execpath: '/tools/pnpm',
      DSH_PNPM_OFFLINE: '1',
    })).toEqual({ command: '/tools/pnpm', args: ['run', 'build'] })
  })
})
