/** Closed HTTP routes and bounded identity IPC; the Frappe authority is external. */
import { createServer as netServer } from 'node:net'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionSummary } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/employee-access.ts'
import { EmployeeIdentity } from '../src/employee-identity.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })
const publicOrigin = 'https://preview.example.test'
const cookie = '__Host-dsh-shared=' + 'A'.repeat(43)

async function fixture(overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-http-id-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const policy = new Context()
  disposers.push(() => policy.fiber.dispose())
  await policy.plugin(SystemPrompt, {})
  await policy.plugin(ToolRuntime)
  let admitted = true
  let reply: string | undefined
  const ipc = netServer({ allowHalfOpen: true }, (socket) => {
    let input = ''
    socket.on('data', (chunk) => { input += String(chunk) })
    socket.once('end', () => {
      const value = JSON.parse(input) as { operation: string }
      if (reply !== undefined) { socket.end(reply); return }
      let result: object = { site: 'example.test', user: 'teacher@example.test' }
      if (value.operation === 'login') result = { cookie: 'A'.repeat(43), maxAge: 600 }
      if (value.operation === 'logout') { admitted = false; result = {} }
      socket.end(JSON.stringify({ ok: value.operation === 'logout' || admitted, result }) + '\n')
    })
  })
  const socketPath = join(root, 'authority.sock')
  ipc.listen(socketPath)
  await once(ipc, 'listening')
  disposers.push(() => new Promise<void>((resolve, reject) => {
    ipc.close((error) => { if (error) reject(error); else resolve() })
  }))
  let route: WebRoute | undefined
  let release: (() => Promise<void>) | undefined
  let missingSession = false
  let didAbort!: () => void
  const abortedRead = new Promise<void>((resolve) => { didAbort = resolve })
  let blocked: { entered: () => void; wait: Promise<void> } | undefined
  const rows: SessionSummary[] = []
  const ctx = {
    on: policy.on.bind(policy),
    tools: policy.tools,
    webServer: { register(value: WebRoute) { route = value; return () => { route = undefined } } },
    sessionController: {
      async create(value: { sessionId: SessionSummary['sessionId'] }) {
        rows.push({ sessionId: value.sessionId, updatedAt: 1, running: false, blank: true })
        return value
      },
      async list(_request: unknown, signal: AbortSignal) {
        if (blocked !== undefined) {
          blocked.entered()
          await new Promise<void>((resolve, reject) => {
            const aborted = (): void => { didAbort(); reject(new Error('cancelled')) }
            signal.addEventListener('abort', aborted, { once: true })
            void blocked?.wait.then(() => { signal.removeEventListener('abort', aborted); resolve() })
          })
        }
        return { items: rows }
      },
      async page() { return { records: [], hasMore: false } },
    },
    sessions: { get() { return missingSession ? undefined : {} } },
    sessionPersistence: { async ensureMaterialized() {} },
    effect(factory: () => () => Promise<void> | void) {
      const dispose = factory()
      const previous = release
      release = async () => { await dispose(); await previous?.() }
    },
  } as unknown as Context
  const config: Config = { publicOrigin, identitySocketPath: socketPath, ownersDirectory: join(root, 'owners'),
    timeoutMs: 5000, maxRequests: 8, maxOwnershipEntries: 100, maxResponseBytes: 4096, ...overrides }
  await apply(ctx, config)
  disposers.push(async () => { await release?.() })
  const http = createServer((req, res) => {
    if (route === undefined) { res.writeHead(404); res.end(); return }
    void route.handler(req, res)
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  disposers.push(() => new Promise<void>((resolve, reject) => {
    http.closeAllConnections()
    http.close((error) => { if (error) reject(error); else resolve() })
  }))
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('fixture lacks a port')
  const port = address.port
  async function call(path: string, body?: string, headers: Record<string, string | undefined> = {}, signal?: AbortSignal) {
    return new Promise<{ status: number; text: string; cookie?: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST',
        ...(signal === undefined ? {} : { signal }),
        headers: Object.fromEntries(Object.entries({ host: 'preview.example.test', origin: publicOrigin, cookie,
          'content-type': 'application/json', ...headers }).filter(([, value]) => value !== undefined)) }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += String(chunk) })
        res.once('end', () => { resolve({ status: res.statusCode ?? 0, text,
          ...(res.headers['set-cookie']?.[0] === undefined ? {} : { cookie: res.headers['set-cookie'][0] }) }) })
        res.once('error', reject)
      })
      req.once('error', reject)
      req.end(body)
    })
  }
  const registered = route
  return { call, socketPath, rows, abortedRead, policy, setReply(value: string) { reply = value },
    setMissing() { missingSession = true },
    async release() { await release?.() },
    reviveStaleRoute() { route = registered },
    blockReads() {
      let entered!: () => void
      let unblock!: () => void
      const waiting = new Promise<void>((resolve) => { entered = resolve })
      const wait = new Promise<void>((resolve) => { unblock = resolve })
      blocked = { entered, wait }
      disposers.push(async () => { unblock() })
      return waiting
    },
  }
}

describe.skipIf(process.platform !== 'linux')('shared HTTP preview', () => {
  it.each([undefined, 'employee-shared-readonly'])('denies unbound tool execution and disposes the guard (preset %s)', async (promptPreset) => {
    const f = await fixture(promptPreset === undefined ? {} : { promptPreset })
    const created = await f.call('/employee/session/create', '{}')
    const { sessionId } = JSON.parse(created.text) as { sessionId: SessionId }
    let calls = 0
    f.policy.tools.register({ name: 'probe', description: 'test', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => { calls++; return 'executed' },
    })
    f.policy.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
    const agent = { id: sessionId, session: { id: sessionId } } as Agent
    const execute = (actor?: Agent) => f.policy.tools.execute({ callId: ToolCallId('probe'), name: 'probe',
      arguments: {}, signal: new AbortController().signal, ...(actor === undefined ? {} : { agent: actor }) })
    expect(JSON.stringify(await execute(agent))).toContain('Employee Agent execution is unavailable.')
    expect(JSON.stringify(await execute())).toContain('Employee Agent execution is unavailable.')
    expect(calls).toBe(0)
    await f.release()
    expect(JSON.stringify(await execute(agent))).toContain('executed')
    expect(calls).toBe(1)
  })

  it('serves only explicit owned session routes and removes its registration on disposal', async () => {
    const f = await fixture()
    const login = await f.call('/employee/sso?token=synthetic')
    expect(login.status).toBe(303)
    expect(login.cookie).toContain('HttpOnly; Secure; SameSite=Strict')
    const status = await f.call('/employee/status')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.text)).toEqual({ access: 'read-preview', agentExecution: false })
    const created = await f.call('/employee/session/create', '{}')
    expect(created.status).toBe(200)
    const id = (JSON.parse(created.text) as { sessionId: string }).sessionId
    expect((await f.call('/employee/session/list', '{}')).text).toContain(id)
    expect((await f.call('/employee/session/page', JSON.stringify({ sessionId: id, throughSeq: -1,
      maxMessages: 5, beforeSeq: 1 }))).status).toBe(200)
    expect((await f.call('/employee/session/read', JSON.stringify({ sessionId: id,
      operation: 'frappe_describe_doctype', arguments: { doctype: 'Student' } }))).status).toBe(200)
    expect((await f.call('/employee/logout', '{}')).status).toBe(204)
    expect((await f.call('/employee/status')).status).toBe(401)
    await f.release()
    expect((await f.call('/employee/status')).status).toBe(404)
    f.reviveStaleRoute()
    expect((await f.call('/employee/status')).status).toBe(503)
  })

  it('rejects ambiguous cookies, origins, identity fields, malformed JSON and excessive request bytes', async () => {
    const f = await fixture()
    for (const value of [undefined, '', 'wrong=1', cookie + '; ' + cookie, '__Host-dsh-shared=short']) {
      expect((await f.call('/employee/status', undefined, { cookie: value })).status).toBe(401)
    }
    expect((await f.call('/employee/status', undefined, { host: 'attacker.test' })).status).toBe(400)
    expect((await f.call('/employee/session/list', '{}', { origin: 'https://attacker.test' })).status).toBe(400)
    expect((await f.call('/employee/session/list', '{}', { 'content-type': 'text/plain' })).status).toBe(400)
    expect((await f.call('/employee/session/list', '{bad')).status).toBe(400)
    expect((await f.call('/employee/session/list', 'x'.repeat(8193))).status).toBe(413)
    expect((await f.call('/employee/session/list', '{"user":"finance@example.test"}')).status).toBe(400)
    expect((await f.call('/employee/session/page', '{}')).status).toBe(400)
    expect((await f.call('/employee/session/follow', '{}')).status).toBe(404)
    expect((await f.call('/employee/sso?token=a&token=b')).status).toBe(400)
    expect((await f.call('/employee/sso?other=a')).status).toBe(400)
    expect((await f.call('/employee/status?user=other')).status).toBe(400)
    expect((await f.call('/employee/session/list')).status).toBe(400)
  })

  it('contains invalid or oversized identity replies and socket failures without private diagnostics', async () => {
    const f = await fixture()
    for (const value of ['not JSON', '{"ok":false,"error":"private detail"}', 'x'.repeat(8193),
      '{"ok":true,"result":{"site":"example.test","user":"teacher@example.test","extra":true}}']) {
      f.setReply(value)
      const response = await f.call('/employee/status')
      expect(response.status).toBe(401)
      expect(response.text).not.toContain('private detail')
    }
    const authority = new EmployeeIdentity(f.socketPath + '-absent', 100)
    await expect(authority.authorize('opaque', new AbortController().signal)).rejects.toMatchObject({ status: 401 })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(authority.authorize('opaque', cancelled.signal)).rejects.toMatchObject({ status: 401 })
    await expect(authority.request('login', 'x'.repeat(8193), new AbortController().signal)).rejects.toMatchObject({ status: 401 })
    const available = new EmployeeIdentity(f.socketPath, 5000)
    f.setReply(JSON.stringify({ ok: true, result: { rows: ['x'.repeat(10000)] } }))
    expect(await available.read('opaque', 'frappe_list_documents', { doctype: 'Student' }, new AbortController().signal))
      .toMatchObject({ rows: ['x'.repeat(10000)] })
    f.setReply('x'.repeat(262145))
    await expect(available.read('opaque', 'frappe_list_documents', { doctype: 'Student' }, new AbortController().signal))
      .rejects.toMatchObject({ status: 401 })
  })

  it('fails closed for malformed deployment and missing created sessions', async () => {
    await expect(fixture({ publicOrigin: 'http://preview.example.test' })).rejects.toMatchObject({ status: 503 })
    const f = await fixture()
    f.setMissing()
    expect((await f.call('/employee/session/create', '{}')).status).toBe(503)
    f.setReply('{"ok":true,"result":{"cookie":"bad"}}')
    expect((await f.call('/employee/sso?token=synthetic')).status).toBe(503)
  })

  it('bounds complete output and admitted requests and aborts a timed-out operation', async () => {
    const f = await fixture({ maxResponseBytes: 1024, timeoutMs: 250, maxRequests: 1 })
    for (let index = 0; index < 12; index++) expect((await f.call('/employee/session/create', '{}')).status).toBe(200)
    expect((await f.call('/employee/session/list', '{}')).status).toBe(503)
    const entered = f.blockReads()
    const pending = expect(f.call('/employee/session/list', '{}')).rejects.toThrow()
    await entered
    expect((await f.call('/employee/status')).status).toBe(503)
    await pending
  })

  it('cancels and joins an admitted request when the plugin is disposed', async () => {
    const f = await fixture()
    const entered = f.blockReads()
    const pending = expect(f.call('/employee/session/list', '{}')).rejects.toThrow()
    await entered
    await f.release()
    await pending
  })

  it('cancels an operation when its client disconnects', async () => {
    const f = await fixture()
    const entered = f.blockReads()
    const client = new AbortController()
    const pending = expect(f.call('/employee/session/list', '{}', {}, client.signal)).rejects.toThrow()
    await entered
    client.abort()
    await pending
    await f.abortedRead
    await f.release()
  })
})
