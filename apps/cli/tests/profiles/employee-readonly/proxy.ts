/** Exercise the optional proxy with disposable identities, never production credentials. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, vi } from 'vitest'

export async function wrapEmployeeProxy(
  disposers: (() => Promise<unknown>)[], upstream: string, nativeCookie: string, launchUrl: string,
) {
  const python = process.env.DSH_EMPLOYEE_PROXY_PYTHON
  if (python === undefined) return undefined
  const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
  const child = execa(python, ['-B', join(repo,
    'packages/extensions/tool-native-bench-frappe/tests/employee_proxy_fixture.py')], {
    env: { PATH: process.env.PATH }, extendEnv: false, reject: false,
    forceKillAfterDelay: 5000,
  })
  disposers.push(async () => {
    child.stdin?.end()
    const result = await child
    expect(result.timedOut).toBe(false)
    expect(result.isForcefullyTerminated).toBe(false)
    expect(result.exitCode).toBe(0)
  })
  let output = ''
  child.stdout?.on('data', (data: Buffer) => { output += data.toString('utf8') })
  child.stdin?.write(JSON.stringify({
    user: 'employee-fixture@example.test', upstream,
    launch: new URL(launchUrl).searchParams.get('token'),
  }) + '\n')
  let ready: { origin: string; cookie: string; publicOrigin: string } | undefined
  await vi.waitFor(() => {
    const line = output.split('\n')[0]
    if (!line || !output.includes('\n')) throw new Error('employee proxy not ready')
    ready = JSON.parse(line) as { origin: string; cookie: string; publicOrigin: string }
  }, { timeout: 30000 })
  if (ready === undefined) throw new Error('employee proxy did not publish readiness')
  const { origin, cookie: employeeCookie, publicOrigin } = ready
  const cookie = employeeCookie + '; ' + nativeCookie
  const headers = { Origin: publicOrigin }
  async function logout() {
    const result = await fetch(origin + '/logout', {
      method: 'POST', headers: { ...headers, cookie },
    })
    expect(result.status).toBe(204)
  }
  return { origin, cookie, headers, logout }
}
