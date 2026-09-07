/** Private real-process fixture shared by employee protocol and recorded-session owners. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { wrapEmployeeProxy } from './proxy.ts'
import { expect, vi } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const overlay = join(repo, 'apps/cli/config/examples/employee-readonly/cordis.yml')
const presets = join(repo, 'apps/cli/config/examples/employee-readonly/presets')
export async function disposeEmployeeFixtures(disposers: (() => Promise<unknown>)[]) {
  const failures: unknown[] = []
  for (const dispose of disposers.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'employee fixture cleanup failed')
}

interface RpcReply {
  result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

export async function startEmployee(
  disposers: (() => Promise<unknown>)[], label: string, baseURL: string, existingRoot?: string,
  replayFixture?: string, brokerMode = false,
  sharedAccess?: { socketPath: string; publicOrigin: string },
  businessPolicy = false,
) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-employee-profile-'))
  if (existingRoot === undefined) disposers.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  // Materialize the profile's declared local plugin dependency without a registry download.
  const profileDir = join(home, 'profiles', 'web')
  const moduleDir = join(profileDir, 'node_modules', '@deepseek-ai')
  if (existingRoot === undefined) {
    await mkdir(moduleDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'employee-fixture-profile', private: true,
      dsh: { profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup',
      } },
      dependencies: {
        '@deepseek-ai/dsh-tool-native-bench-source': 'link:' + join(repo, 'packages/extensions/tool-native-bench-source'),
        '@deepseek-ai/dsh-tool-native-bench-frappe': 'link:' + join(repo, 'packages/extensions/tool-native-bench-frappe'),
        '@deepseek-ai/dsh-llm-replay': 'link:' + join(repo, 'packages/test-support/llm-replay'),
      },
    }))
    await symlink(join(repo, 'packages/extensions/tool-native-bench-frappe'),
      join(moduleDir, 'dsh-tool-native-bench-frappe'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(repo, 'packages/extensions/tool-native-bench-source'),
      join(moduleDir, 'dsh-tool-native-bench-source'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(repo, 'packages/test-support/llm-replay'),
      join(moduleDir, 'dsh-llm-replay'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const fixturePatch = join(root, 'model.patch.yml')
  await writeFile(fixturePatch, JSON.stringify([
    { id: 'llm-deepseek', disabled: replayFixture !== undefined, config: { baseURL, apiKeyEnv: 'EMPLOYEE_FIXTURE_MODEL_KEY' } },
    ...(replayFixture === undefined ? [] : [{ insert: [{
      id: 'llm-replay', name: '@deepseek-ai/dsh-llm-replay', config: {
        file: replayFixture,
        providers: [{ id: 'deepseek-official', name: 'DeepSeek',
          models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }],
      },
    }] }]),
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    ...(businessPolicy ? [{ insert: [{
      id: 'business-frappe-fixture', name: '@deepseek-ai/dsh-tool-native-bench-frappe', config: {
        benchRoot: join(root, 'missing-bench'), site: 'example.test', frappeUser: 'fixture@example.test',
      },
    }] }] : []),
  ]))
  const launch = resolveExampleLaunch({
    srcBin: join(repo, 'apps/cli/src/bin.ts'),
    tsconfigPath: join(repo, 'tsconfig.base.json'),
    sourceImport: 'tsx/esm',
    configArgs: ['--profile', 'web', '--patch', overlay,
      ...(sharedAccess === undefined ? [] : ['--patch', join(repo, 'apps/cli/config/examples/employee-shared/cordis.yml')]),
      '--patch', fixturePatch,
      ...(businessPolicy ? ['--patch', join(repo, 'apps/cli/config/examples/native-bench-business/cordis.yml')] : []),
      '--no-open', '--host', '127.0.0.1', '--port', '0'],
  })
  // No inherited credentials, homes, model routes, or user Node hooks enter the child.
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP, TMP: process.env.TMP,
    ...launch.env,
    DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
    EMPLOYEE_FIXTURE_MODEL_KEY: 'synthetic-no-provider-key',
    DSH_EMPLOYEE_PRESET_ROOT: presets,
    DSH_NATIVE_BENCH_BUSINESS_PRESET_ROOT: join(repo, 'apps/cli/config/examples/native-bench-business/presets'),
    DSH_NATIVE_BENCH_BUSINESS_WORKSPACE: root,
    ...(sharedAccess === undefined ? {} : {
      DSH_SHARED_IDENTITY_SOCKET: sharedAccess.socketPath, DSH_SHARED_PUBLIC_ORIGIN: sharedAccess.publicOrigin,
      DSH_SHARED_OWNERS_DIRECTORY: join(home, 'employee-owners'),
    }),
    DSH_EMPLOYEE_BENCH_ROOT: join(root, 'missing-bench'),
    DSH_EMPLOYEE_SITE: 'example.test',
    ...(brokerMode ? { DSH_EMPLOYEE_BROKER_SOCKET: join(root, 'absent-broker.sock') } : {
      DSH_EMPLOYEE_USER: label + '@example.test',
      DSH_EMPLOYEE_ASSERTION_FILE: join(root, 'absent-assertion'),
    }),
    DSH_EMPLOYEE_DOCTYPES: '["Student"]',
    NODE_NO_WARNINGS: '1',
  }
  const child = execa(launch.command, launch.args, {
    cwd: root, env, extendEnv: false, reject: false, forceKillAfterDelay: 5000,
  })
  let settled = false
  void child.then(() => { settled = true })
  const stop = async () => {
    if (!settled) child.kill('SIGTERM')
    const result = await child
    expect(result.timedOut).toBe(false)
    expect(result.isForcefullyTerminated).toBe(false)
  }
  disposers.push(stop)
  let output = ''
  let errors = ''
  child.stdout?.on('data', (data: Buffer) => { output += data.toString('utf8') })
  child.stderr?.on('data', (data: Buffer) => { errors += data.toString('utf8') })
  const safeLog = () => (output + errors).replace(/token=[^\s&]+/gu, 'token=[redacted]')
  let url: string | undefined
  await vi.waitFor(() => {
    url = /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
    if (url === undefined) throw new Error(`employee not ready (exited=${String(settled)}): ${safeLog()}`)
  }, { timeout: 30000 })
  if (url === undefined) throw new Error('employee URL missing')
  let origin = new URL(url).origin
  const exchange = await fetch(url, { redirect: 'manual' })
  let cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('employee browser credential exchange failed')
  const html = await (await fetch(origin, { headers: { cookie } })).text()
  expect(html).toContain('__DSH_BOOT__')
  const proxy = sharedAccess === undefined ? await wrapEmployeeProxy(disposers, origin, cookie, url) : undefined
  const headers = proxy?.headers ?? {}
  if (proxy !== undefined) { origin = proxy.origin; cookie = proxy.cookie }
  async function raw(method: string, args: object = {}, otherCookie = cookie) {
    return fetch(`${origin}/api/${method}`, {
      method: 'POST', headers: { ...headers, cookie: otherCookie ?? '', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'employee-fixture', method, payload: { args } }),
    })
  }
  async function rpc(method: string, args: object = {}): Promise<RpcReply['result']> {
    const response = await raw(method, args)
    expect(response.status, method).toBe(200)
    return (await response.json() as RpcReply).result
  }
  return { root, home, origin, cookie, headers, logout: proxy?.logout, raw, rpc, stop, safeLog }
}

export async function logs(home: string): Promise<string> {
  const dir = join(home, 'sessions')
  const names = (await readdir(dir, { recursive: true })).sort()
  return (await Promise.all(names.filter(name => name.endsWith('.jsonl'))
    .map(name => readFile(join(dir, name), 'utf8')))).join('\n')
}
