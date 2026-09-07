/** Opt-in account-owned session API preview for one shared Harness process.
 * No prompt, tool execution, attachment, search, or global event endpoint is exposed.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SessionController } from './index.ts'
import { EmployeeAccessError, EmployeeIdentity, type EmployeePrincipal } from './employee-identity.ts'
import { EmployeeOwners, sameEmployee } from './employee-owners.ts'

/** Stable plugin name for the opt-in shared session API. */
export const name = 'employee-session-access'
/** Core services required by the shared session API. */
export const inject = ['webServer', 'sessionController', 'sessions', 'sessionPersistence']

/** Explicit deployment settings; this API has no production-default profile. */
export interface Config {
  /** HTTPS origin used for exact Host and Origin validation. */
  publicOrigin: string
  /** Private authority socket, reachable only by the configured runtime UID. */
  identitySocketPath: string
  /** Canonical private directory for immutable owner records. */
  ownersDirectory: string
  /** Complete HTTP operation deadline, including authority checks. */
  timeoutMs: number
  /** Maximum simultaneous requests admitted by this plugin. */
  maxRequests: number
  /** Maximum ownership records scanned by a list operation. */
  maxOwnershipEntries: number
  /** Maximum serialized success response bytes. */
  maxResponseBytes: number
}

export const Config: schema<Config> = schema.object({
  publicOrigin: schema.string(),
  identitySocketPath: schema.string(),
  ownersDirectory: schema.string(),
  timeoutMs: schema.number().step(1).min(1).max(120000),
  maxRequests: schema.number().step(1).min(1).max(64),
  maxOwnershipEntries: schema.number().step(1).min(1).max(100000),
  maxResponseBytes: schema.number().step(1).min(1024).max(5000000),
})

const COOKIE = '__Host-dsh-shared'
const emptySchema = z.object({}).strict()
const pageSchema = z.object({
  sessionId: z.string().regex(/^session-[0-9a-f-]{36}$/u),
  throughSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  beforeSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxMessages: z.number().int().min(1).max(100).optional(),
}).strict()

/** Execute account-owned operations; authorization is repeated before releasing results. */
export class EmployeeSessionAccess {
  /**
   * @param controller - trusted in-process session API, never exposed to employees directly.
   * @param owners - durable immutable owner records.
   * @param identity - current-account authority.
   * @param materialize - commit the exact created session before acknowledging it.
   */
  constructor(
    private readonly controller: Pick<SessionController, 'create' | 'list' | 'page'>,
    private readonly owners: EmployeeOwners,
    private readonly identity: Pick<EmployeeIdentity, 'authorize'>,
    private readonly materialize: (sessionId: SessionId) => Promise<void>,
  ) {}

  private async recheck(credential: string, principal: EmployeePrincipal, signal: AbortSignal): Promise<void> {
    if (!sameEmployee(principal, await this.identity.authorize(credential, signal))) throw new EmployeeAccessError(401)
    signal.throwIfAborted()
  }

  /**
   * Run one permitted operation without trusting account, session-owner, or preset fields from input.
   * @param operation - exact preview operation; every other operation is denied.
   * @param input - untrusted request JSON.
   * @param credential - opaque login retained only for this request.
   * @param signal - request lifetime; cancellation does not roll back accepted creation.
   * @returns owned session data after current-account revalidation.
   */
  async execute(operation: string, input: unknown, credential: string, signal: AbortSignal): Promise<unknown> {
    const principal = await this.identity.authorize(credential, signal)
    let result: unknown
    if (operation === 'create') {
      if (!emptySchema.safeParse(input).success) throw new EmployeeAccessError(400)
      const sessionId = brandString<SessionId>('session-' + randomUUID())
      await this.owners.reserve(sessionId, principal)
      await this.recheck(credential, principal, signal)
      result = await this.controller.create({ sessionId })
      await this.materialize(sessionId)
    } else if (operation === 'list') {
      if (!emptySchema.safeParse(input).success) throw new EmployeeAccessError(400)
      const ids = await this.owners.ownedIds(principal)
      const list = await this.controller.list({}, signal)
      result = { items: list.items.filter(item => ids.has(item.sessionId)).map(item => ({
        sessionId: item.sessionId, updatedAt: item.updatedAt, running: item.running, blank: item.blank,
      })) }
    } else if (operation === 'page') {
      const parsed = pageSchema.safeParse(input)
      if (!parsed.success) throw new EmployeeAccessError(400)
      const { sessionId: rawId, ...page } = parsed.data
      const sessionId = brandString<SessionId>(rawId)
      await this.owners.assertOwner(sessionId, principal)
      result = await this.controller.page({
        address: { kind: 'session', sessionId }, throughSeq: page.throughSeq,
        ...(page.beforeSeq === undefined ? {} : { beforeSeq: page.beforeSeq }),
        ...(page.maxMessages === undefined ? {} : { maxMessages: page.maxMessages }),
      }, signal)
    } else {
      throw new EmployeeAccessError(404)
    }
    await this.recheck(credential, principal, signal)
    return result
  }
}

function credential(request: IncomingMessage): string {
  const entries = (request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.split('=', 1)[0] === COOKIE)
  if (entries.length !== 1) throw new EmployeeAccessError(401)
  const value = entries[0]?.slice(COOKIE.length + 1)
  if (value === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new EmployeeAccessError(401)
  return value
}

function send(response: ServerResponse, status: number, value?: string, headers: Record<string, string> = {}): void {
  if (response.destroyed) return
  response.writeHead(status, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-type': 'application/json', 'x-content-type-options': 'nosniff', ...headers })
  response.end(value)
}

async function body(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') throw new EmployeeAccessError(400)
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    signal.throwIfAborted()
    const bytes = chunk as Buffer
    size += bytes.length
    if (size > 8192) throw new EmployeeAccessError(413)
    chunks.push(bytes)
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown }
  catch { throw new EmployeeAccessError(400) }
}

/**
 * Mount the closed employee API; disposal aborts and awaits admitted operations.
 * @param ctx - Host context containing the real Session Controller.
 * @param config - explicit validated deployment settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const origin = new URL(config.publicOrigin)
  if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin
    || process.platform !== 'linux' || !isAbsolute(config.identitySocketPath)
    || Buffer.byteLength(config.identitySocketPath) > 107 || /[\u0000\r\n]/u.test(config.identitySocketPath)) {
    throw new EmployeeAccessError(503)
  }
  const owners = new EmployeeOwners(config.ownersDirectory, config.maxOwnershipEntries)
  await owners.initialize()
  const identity = new EmployeeIdentity(config.identitySocketPath, config.timeoutMs)
  const access = new EmployeeSessionAccess(ctx.sessionController, owners, identity, async (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new EmployeeAccessError(503)
    await ctx.sessionPersistence.ensureMaterialized(session)
  })
  const requests = new Map<Promise<void>, AbortController>()
  let closing = false

  async function handle(req: IncomingMessage, res: ServerResponse, abort: AbortController): Promise<void> {
    const destroy = (): void => { req.destroy(); res.destroy() }
    const expire = (): void => { abort.abort() }
    const disconnected = (): void => { abort.abort() }
    const timer = setTimeout(expire, config.timeoutMs)
    timer.unref()
    abort.signal.addEventListener('abort', destroy, { once: true })
    res.once('close', disconnected)
    try {
      // node:http supplies a URL for every server request passed to this route.
      const requestUrl = req.url as string
      if (req.headers.host !== origin.host || requestUrl.length > 4608) throw new EmployeeAccessError(400)
      const url = new URL(requestUrl, config.publicOrigin)
      if (url.pathname === '/employee/sso' && req.method === 'GET') {
        const tickets = url.searchParams.getAll('token')
        if (tickets.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'token')) throw new EmployeeAccessError(400)
        const login = z.object({ cookie: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
          maxAge: z.number().int().min(60).max(28800) }).strict()
          .parse(await identity.request('login', tickets[0] as string, abort.signal))
        send(res, 303, undefined, { location: '/employee/status',
          'set-cookie': `${COOKIE}=${login.cookie}; Path=/; Max-Age=${String(login.maxAge)}; HttpOnly; Secure; SameSite=Strict` })
        return
      }
      const login = credential(req)
      if (url.search !== '') throw new EmployeeAccessError(400)
      if (url.pathname === '/employee/status' && req.method === 'GET') {
        await identity.authorize(login, abort.signal)
        send(res, 200, JSON.stringify({ access: 'session-preview', businessExecution: false }))
        return
      }
      if (req.method !== 'POST' || req.headers.origin !== config.publicOrigin) throw new EmployeeAccessError(400)
      if (url.pathname === '/employee/logout') {
        await identity.request('logout', login, abort.signal)
        send(res, 204, undefined, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` })
        return
      }
      const operation = /^\/employee\/session\/(create|list|page)$/u.exec(url.pathname)?.[1]
      if (operation === undefined) throw new EmployeeAccessError(404)
      const result = await access.execute(operation, await body(req, abort.signal), login, abort.signal)
      const serialized = JSON.stringify(result)
      if (Buffer.byteLength(serialized) > config.maxResponseBytes) throw new EmployeeAccessError(503)
      send(res, 200, serialized)
    } catch (error) {
      send(res, error instanceof EmployeeAccessError ? error.status : 503, '{"error":"employee access unavailable"}')
    } finally {
      clearTimeout(timer)
      abort.signal.removeEventListener('abort', destroy)
      res.off('close', disconnected)
    }
  }

  ctx.effect(() => {
    const unregister = ctx.webServer.register({ kind: 'prefix', path: '/employee', handler: (req, res) => {
      if (closing || requests.size >= config.maxRequests) { send(res, 503); return }
      const abort = new AbortController()
      const pending = handle(req, res, abort)
      requests.set(pending, abort)
      void pending.finally(() => { requests.delete(pending) })
      return pending
    } })
    return async () => {
      closing = true
      unregister()
      for (const abort of requests.values()) abort.abort()
      await Promise.allSettled([...requests.keys()])
    }
  }, 'employee-session-access: closed preview API')
}
