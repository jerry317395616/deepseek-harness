/** Real Loader, HTTP, and WebSocket coverage for deployment-owned Remote permissions. */
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { bindTypertRemote, Remote, type TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import Gateway, { type Config } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

interface Child { readonly id: string }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    employeePolicyChild: TypertLookup<Child, string>
  }
}

/** Fixture business state stays on disk, outside the dispatcher's self-report. */
class EmployeeProbe extends Service {
  static inject = ['typert']
  readonly typertRemote = bindTypertRemote(this, 'employeeProbe')
  lookups = 0
  writes = 0

  constructor(ctx: Context, private readonly config: { file: string }) {
    super(ctx, 'employeeProbe')
    ctx.typert.lookups.register('employeePolicyChild', {
      parameter: 'child', wire: 'childId',
      hostTypeSymbol: '@fixture/employee#Child', wireTypeSymbol: '@fixture/employee#ChildId',
      resolve: (id) => { this.lookups += 1; return { id } },
    })
  }

  @Remote
  async read(): Promise<string> {
    return await readFile(this.config.file, 'utf8')
  }

  @Remote
  async mutate(child: Child): Promise<void> {
    this.writes += 1
    await writeFile(this.config.file, child.id)
  }

  @Remote({ mode: 'stream' })
  async *follow(): AsyncIterable<string> {
    yield await this.read()
  }

  @Remote({ mode: 'stream' })
  async *mutateStream(child: Child): AsyncIterable<string> {
    await this.mutate(child)
    yield child.id
  }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function loadHost(allowedEndpoints?: string[], label = 'employee-a') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-employee-policy-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'owned.txt')
  await writeFile(file, label)
  const configPath = join(root, 'cordis.yml')
  const config: Config = { ...(allowedEndpoints === undefined ? {} : { allowedEndpoints }) }
  await writeFile(configPath, JSON.stringify([
    { id: 'registry', name: 'registry' },
    { id: 'webserver', name: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'connection', name: 'connection' },
    { id: 'gateway', name: 'gateway', config },
    { id: 'probe', name: 'probe', config: { file } },
  ]))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  provideBrowserCredentials(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['registry', TypertRegistry], ['webserver', WebServer], ['connection', Connection],
    ['gateway', Gateway], ['probe', EmployeeProbe],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('unexpected policy fixture import')
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const target = new URL(ctx.connection.authenticatedUrl(origin))
  let cookie: string | undefined
  ctx.connection.authorizeIndex({
    method: 'GET', url: target.pathname + target.search, headers: { host: target.host },
  }, {
    writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] },
    end() {},
  })
  if (cookie === undefined) throw new Error('fixture cookie exchange failed')
  const headers = { 'content-type': 'application/json', cookie }
  const post = async (method: string, args: object, cookieOverride?: string) => {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: cookieOverride === undefined ? headers : { ...headers, cookie: cookieOverride },
      body: JSON.stringify({ type: 'client-request', rpcId: 'policy-test', method, payload: { args } }),
    })
    return response
  }
  const invoke = (method: string, args: Record<string, unknown> = {}) =>
    ctx.typertGateway.invoke({ namespace: 'employeeProbe', method, args })
  const probe = ctx.get('employeeProbe') as EmployeeProbe
  return { ctx, file, post, invoke, probe, origin, cookie }
}

async function openSocket(origin: string, cookie: string) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie } })
  cleanup.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return
    const closed = once(socket, 'close')
    socket.terminate()
    await closed
  })
  const frames: Record<string, unknown>[] = []
  socket.on('message', (data) => {
    if (!Buffer.isBuffer(data)) throw new TypeError('fixture expected a Buffer frame')
    frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>)
  })
  await once(socket, 'open')
  const open = (streamId: string, method: string, args: object = {}) => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: method, payload: { args } }))
  }
  return { socket, frames, open }
}

const denied = { code: 'gateway/forbidden' }

describe('deployment Remote endpoint allowlist', () => {
  it('accepts only exact endpoint names and preserves explicit deny-all', () => {
    expect(Gateway.Config({}).allowedEndpoints).toBe('all')
    expect(Gateway.Config({ allowedEndpoints: [] }).allowedEndpoints).toEqual([])
    expect(Gateway.Config({ allowedEndpoints: ['$events', '$events/result', 'session.lifecycle/create'] })
      .allowedEndpoints).toEqual(['$events', '$events/result', 'session.lifecycle/create'])
    for (const endpoint of ['', '*', 'session/*', 'session', '/session/read', 'a/b/c', 'a/..', 'a/read?x=1']) {
      expect(() => Gateway.Config({ allowedEndpoints: [endpoint] })).toThrow()
    }
  })

  it('denies direct unary and stream dispatch before lookups and business writes', async () => {
    const host = await loadHost(['employeeProbe/read'])
    await expect(host.invoke('read')).resolves.toBe('employee-a')
    await expect(host.invoke('mutate', { childId: 'changed' })).rejects.toMatchObject(denied)
    await expect(host.ctx.typertGateway.stream({
      namespace: 'employeeProbe', method: 'mutateStream', args: { childId: 'changed' },
    })).rejects.toMatchObject(denied)
    expect(host.probe.lookups).toBe(0)
    expect(host.probe.writes).toBe(0)
    expect(await readFile(host.file, 'utf8')).toBe('employee-a')
  })

  it('applies the same denial to strict descriptors and cannot be widened by mutating config', async () => {
    const host = await loadHost([])
    host.ctx.typert.register({
      package: '@fixture/employee-policy', face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [{
        id: '@fixture/employee#read', service: 'employeeProbe', namespace: 'employeeProbe',
        method: 'read', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
      }],
    })
    await expect(host.invoke('read')).rejects.toMatchObject(denied)
    const entry = [...host.ctx.loader.entries()].find(item => item.options.id === 'gateway')
    if (entry === undefined) throw new Error('missing gateway entry')
    const options = entry.options.config as { allowedEndpoints: string[] }
    options.allowedEndpoints.push('employeeProbe/read')
    await expect(host.invoke('read')).rejects.toMatchObject(denied)
  })

  it('enforces HTTP writes and reserved event results without bypassing browser authentication', async () => {
    const host = await loadHost(['employeeProbe/read'])
    expect((await host.post('employeeProbe/read', {}, '')).status).toBe(401)
    const allowed = await host.post('employeeProbe/read', {})
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ result: { ok: true, value: 'employee-a' } })
    for (const endpoint of ['employeeProbe/mutate', '$events/result']) {
      const response = await host.post(endpoint, { childId: 'changed' })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ result: { ok: false, error: denied } })
    }
    expect(host.probe.lookups).toBe(0)
    expect(await readFile(host.file, 'utf8')).toBe('employee-a')
  })

  it('checks each multiplexed WebSocket stream, including forwarded events and in-process carriers', async () => {
    const host = await loadHost(['employeeProbe/follow'])
    const wire = await openSocket(host.origin, host.cookie)
    wire.open('allowed', 'employeeProbe/follow')
    wire.open('denied', 'employeeProbe/mutateStream', { childId: 'changed' })
    wire.open('events', '$events')
    await vi.waitFor(() => {
      expect(wire.frames.filter(frame => frame.streamId === 'allowed')).toEqual([
        { type: 'item', streamId: 'allowed', value: 'employee-a' },
        { type: 'end', streamId: 'allowed' },
      ])
      for (const streamId of ['denied', 'events']) {
        expect(wire.frames.find(frame => frame.streamId === streamId))
          .toMatchObject({ type: 'error', streamId, error: denied })
      }
    })
    await expect(host.ctx.typertGateway.wireStream.open(
      '$events', { args: {} }, new AbortController().signal,
    )).rejects.toMatchObject(denied)
    expect(host.probe.lookups).toBe(0)
    expect(await readFile(host.file, 'utf8')).toBe('employee-a')
    const gatewayEntry = [...host.ctx.loader.entries()].find(item => item.options.id === 'gateway')
    if (gatewayEntry === undefined) throw new Error('missing gateway entry')
    const closed = once(wire.socket, 'close')
    await gatewayEntry._dispose()
    await closed
    expect((await host.post('employeeProbe/read', {})).status).toBe(404)
  })

  it('keeps explicitly allowed event endpoints subject to their own protocol validation', async () => {
    const host = await loadHost(['$events', '$events/result'])
    await expect(host.ctx.typertGateway.wireStream.open(
      '$events', { args: {} }, new AbortController().signal,
    ).then(async (stream) => {
      for await (const _item of stream) { /* No source is registered in this fixture. */ }
    })).rejects.toMatchObject({ code: 'gateway/service-unavailable' })
    expect(await (await host.post('$events/result', {})).json())
      .toMatchObject({ result: { ok: false, error: { code: 'gateway/internal' } } })
  })

  it('keeps unrestricted behavior opt-out and separates two live Loader hosts', async () => {
    const [a, b] = await Promise.all([
      loadHost(undefined, 'employee-a'),
      loadHost(['employeeProbe/read'], 'employee-b'),
    ])
    await expect(a.invoke('mutate', { childId: 'a-updated' })).resolves.toBeUndefined()
    expect(await readFile(a.file, 'utf8')).toBe('a-updated')
    expect(await readFile(b.file, 'utf8')).toBe('employee-b')
    expect((await b.post('employeeProbe/read', {}, a.cookie)).status).toBe(401)
    expect(await (await b.post('employeeProbe/read', {})).json())
      .toMatchObject({ result: { ok: true, value: 'employee-b' } })
    expect(await (await b.post('employeeProbe/read', { file: a.file })).json())
      .toMatchObject({ result: { ok: false, error: { code: 'gateway/arguments-invalid' } } })
    await expect(b.invoke('mutate', { childId: 'cross-host' })).rejects.toMatchObject(denied)
    expect(await readFile(a.file, 'utf8')).toBe('a-updated')
    expect(await readFile(b.file, 'utf8')).toBe('employee-b')
  })
})
