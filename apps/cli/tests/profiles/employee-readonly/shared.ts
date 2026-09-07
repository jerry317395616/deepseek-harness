/** Synthetic identity authority shared by real-process account tests and transcript replay. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { execa } from 'execa'
import { expect, vi } from 'vitest'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const publicOrigin = 'https://shared.example.test'

export async function startSharedAuthority(disposers: (() => Promise<unknown>)[]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-id-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'authority.sock')
  const statePath = join(root, 'accounts.json')
  const accounts = { 'teacher@example.test': true, 'finance@example.test': true }
  await writeFile(statePath, JSON.stringify(accounts), { mode: 0o600 })
  const child = execa(process.env.DSH_SHARED_IDENTITY_PYTHON ?? 'python3', ['-B',
    join(repo, 'packages/extensions/tool-native-bench-frappe/tests/shared_identity_fixture.py'),
    socketPath, statePath], { reject: false, extendEnv: false,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, forceKillAfterDelay: 5000 })
  let settled = false
  void child.then(() => { settled = true })
  disposers.push(async () => {
    if (!settled) child.kill('SIGTERM')
    const result = await child
    expect(result.timedOut).toBe(false)
    expect(result.isForcefullyTerminated).toBe(false)
    expect(result.exitCode).toBe(0)
  })
  let output = ''
  child.stdout?.on('data', (data: Buffer) => { output += data.toString('utf8') })
  await vi.waitFor(() => {
    expect(settled).toBe(false)
    expect(output).toContain('shared identity fixture ready')
  }, { timeout: 5000 })
  // Observe the signed-ticket second after authority readiness; never mint a future ticket.
  const readySecond = Math.floor(Date.now() / 1000)
  await vi.waitFor(() => { expect(Math.floor(Date.now() / 1000)).toBeGreaterThan(readySecond) }, { timeout: 5000 })
  function ticket(user: keyof typeof accounts): string {
    const issued = Math.floor(Date.now() / 1000)
    const body = Buffer.from(JSON.stringify({ iss: 'example.test', sub: user,
      iat: issued, exp: issued + 60, jti: randomBytes(16).toString('base64url') })).toString('base64url')
    return body + '.' + createHmac('sha256', 'synthetic-shared-identity-key-00000').update(body).digest('base64url')
  }
  async function disable(user: keyof typeof accounts): Promise<void> {
    accounts[user] = false
    await writeFile(statePath, JSON.stringify(accounts))
  }
  return { socketPath, publicOrigin, ticket, disable }
}

export async function sharedRequest(
  origin: string, path: string, cookie?: string, input?: object, signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, origin), { method: input === undefined ? 'GET' : 'POST',
      ...(signal === undefined ? {} : { signal }),
      headers: { host: new URL(publicOrigin).host, origin: publicOrigin,
        ...(cookie === undefined ? {} : { cookie }), 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('error', reject)
      response.once('end', () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers.set(key, value)
          else if (Array.isArray(value)) for (const item of value) headers.append(key, item)
        }
        resolve(new Response(response.statusCode === 204 ? null : new Uint8Array(Buffer.concat(chunks)),
          { status: response.statusCode ?? 500, headers }))
      })
    })
    request.once('error', reject)
    request.setTimeout(10000, () => { request.destroy(new Error('shared HTTP fixture timed out')) })
    request.end(input === undefined ? undefined : JSON.stringify(input))
  })
}

export async function sharedLogin(origin: string, ticket: string) {
  const response = await sharedRequest(origin, '/employee/sso?token=' + encodeURIComponent(ticket))
  expect(response.status).toBe(303)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('shared login did not issue an opaque cookie')
  const raw = (path: string, input: object = {}) => sharedRequest(origin, path, cookie, input)
  return { cookie, raw }
}
