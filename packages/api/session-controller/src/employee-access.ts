/** Opt-in account-owned session and scoped read API for one shared Harness process.
 * Optional read-only turns retain request-private identity through execution.
 */
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SessionController } from './index.ts'
import type { SessionRequestId } from './types.ts'
import { EmployeeAccessError, EmployeeIdentity, type EmployeePrincipal } from './employee-identity.ts'
import { EmployeeOwners, sameEmployee } from './employee-owners.ts'
import { EmployeeTurns } from './employee-turns.ts'

/** Stable plugin name for the opt-in shared session API. */
export const name = 'employee-session-access'
/** Core services required by the shared session API. */
export const inject = ['webServer', 'sessionController', 'sessions', 'sessionPersistence', 'sessionQuery', 'tools', 'agents', 'sessionProjections']

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
  /** Separate bounded deadline for multi-step prompts; tools retain timeoutMs. */
  promptTimeoutMs?: number
  /** Maximum simultaneous requests admitted by this plugin. */
  maxRequests: number
  /** Maximum ownership records scanned by a list operation. */
  maxOwnershipEntries: number
  /** Maximum serialized success response bytes. */
  maxResponseBytes: number
  /** Explicit read-only Agent preset; omission keeps Agent execution disabled. */
  promptPreset?: string
  /** Enable application-owned previews and separate same-origin browser confirmation. */
  applicationPreviews?: boolean
  /** Explicit image-prompt opt-in; native attachment and model validation still apply. */
  allowImages?: boolean
  /** Serialized prompt request limit; other operations retain the 8192-byte limit. */
  maxPromptBytes?: number
}

export const Config: schema<Config> = schema.object({
  publicOrigin: schema.string(),
  identitySocketPath: schema.string(),
  ownersDirectory: schema.string(),
  timeoutMs: schema.number().step(1).min(1).max(120000),
  promptTimeoutMs: schema.number().step(1).min(1).max(600000),
  maxRequests: schema.number().step(1).min(1).max(64),
  maxOwnershipEntries: schema.number().step(1).min(1).max(100000),
  maxResponseBytes: schema.number().step(1).min(1024).max(5000000),
  promptPreset: schema.string(),
  applicationPreviews: schema.boolean(),
  allowImages: schema.boolean(),
  maxPromptBytes: schema.number().step(1).min(8192).max(10000000),
})

const COOKIE = '__Host-dsh-shared'
/** Longer deadlines apply only to the exact prompt route, never read or auth operations. */
export function employeeRequestDeadline(config: Pick<Config, 'timeoutMs' | 'promptTimeoutMs'>,
  method: string | undefined, url: string | undefined): number {
  return method === 'POST' && url === '/employee/session/prompt'
    ? (config.promptTimeoutMs ?? config.timeoutMs) : config.timeoutMs
}
const emptySchema = z.object({}).strict()
const pageSchema = z.object({
  sessionId: z.string().regex(/^session-[0-9a-f-]{36}$/u),
  throughSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
  beforeSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxMessages: z.number().int().min(1).max(100).optional(),
}).strict()
const readSchema = z.object({
  sessionId: pageSchema.shape.sessionId,
  operation: z.enum(['frappe_describe_doctype', 'frappe_list_documents', 'frappe_get_document']),
  arguments: z.record(z.string(), z.unknown()),
}).strict()
const promptSchema = z.object({ sessionId: pageSchema.shape.sessionId, text: z.string().min(1).max(6000),
  requestId: z.uuid().optional(), images: z.array(z.object({
    type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().min(4).max(10000000).regex(/^[A-Za-z0-9+/]+={0,2}$/u).refine(value => value.length % 4 === 0),
    name: z.string().max(255).optional(),
  }).strict()).min(1).max(4).optional() }).strict()
const reviewSchema = z.object({ sessionId: pageSchema.shape.sessionId }).strict()
const confirmationSchema = reviewSchema.extend({
  preview_id: z.string().min(1).max(140), digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

/** Execute account-owned operations; authorization is repeated before releasing results. */
export class EmployeeSessionAccess {
  /**
   * @param controller - trusted in-process session API, never exposed to employees directly.
   * @param owners - durable immutable owner records.
   * @param identity - current-account authority.
   * @param materialize - commit the exact created session before acknowledging it.
   * @param execution - optional deployment-owned authenticated turn executor.
   * @param application - optional private application preview and confirmation transport.
   * @param currentCursor - obtain a current history boundary after the ownership check.
   * @param allowImages - deployment opt-in for images; false rejects them before execution.
   */
  constructor(
    private readonly controller: Pick<SessionController, 'create' | 'list' | 'page'>,
    private readonly owners: EmployeeOwners,
    private readonly identity: Pick<EmployeeIdentity, 'authorize' | 'read'>,
    private readonly materialize: (sessionId: SessionId) => Promise<void>,
    private readonly execution?: { preset: string; turns: EmployeeTurns },
    private readonly application?: Pick<EmployeeIdentity, 'application'>,
    private readonly currentCursor?: (sessionId: SessionId, signal: AbortSignal) => Promise<number>,
    private readonly allowImages = false,
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
      result = await this.controller.create({ sessionId,
        ...(this.execution === undefined ? {} : { agentPreset: this.execution.preset }) })
      await this.materialize(sessionId)
    } else if (operation === 'list') {
      if (!emptySchema.safeParse(input).success) throw new EmployeeAccessError(400)
      const ids = await this.owners.ownedIds(principal)
      const list = await this.controller.list({}, signal)
      result = { items: list.items.filter(item => ids.has(item.sessionId)).map(item => ({
        sessionId: item.sessionId, updatedAt: item.updatedAt, running: item.running, blank: item.blank,
      })) }
    } else if (operation === 'prompt' && this.execution !== undefined) {
      const parsed = promptSchema.safeParse(input)
      if (!parsed.success) throw new EmployeeAccessError(400)
      if (parsed.data.images !== undefined && !this.allowImages) throw new EmployeeAccessError(400)
      const sessionId = brandString<SessionId>(parsed.data.sessionId)
      await this.owners.assertOwner(sessionId, principal)
      result = await this.execution.turns.prompt(sessionId, parsed.data.text, credential, principal, signal,
        parsed.data.requestId === undefined ? undefined : brandString<SessionRequestId>(parsed.data.requestId),
        parsed.data.images?.map(({ name, ...image }) => ({ ...image, ...(name === undefined ? {} : { name }) })))
    } else if (operation === 'read') {
      const parsed = readSchema.safeParse(input)
      if (!parsed.success) throw new EmployeeAccessError(400)
      const sessionId = brandString<SessionId>(parsed.data.sessionId)
      await this.owners.assertOwner(sessionId, principal)
      await this.recheck(credential, principal, signal)
      result = await this.identity.read(credential, parsed.data.operation, parsed.data.arguments, signal)
    } else if ((operation === 'review' || operation === 'confirm' || operation === 'capabilities') && this.application !== undefined) {
      const parsed = (operation === 'confirm' ? confirmationSchema : reviewSchema).safeParse(input)
      if (!parsed.success) throw new EmployeeAccessError(400)
      const { sessionId: rawId, ...arguments_ } = parsed.data
      const sessionId = brandString<SessionId>(rawId)
      await this.owners.assertOwner(sessionId, principal)
      await this.recheck(credential, principal, signal)
      result = await this.application.application(credential, sessionId, operation, arguments_, signal)
    } else if (operation === 'page') {
      const parsed = pageSchema.safeParse(input)
      if (!parsed.success) throw new EmployeeAccessError(400)
      const { sessionId: rawId, ...page } = parsed.data
      const sessionId = brandString<SessionId>(rawId)
      await this.owners.assertOwner(sessionId, principal)
      const throughSeq = page.throughSeq ?? await this.currentCursor?.(sessionId, signal)
      if (throughSeq === undefined) throw new EmployeeAccessError(503)
      result = await this.controller.page({
        address: { kind: 'session', sessionId }, throughSeq,
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
  if (!response.headersSent) response.writeHead(status, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-type': 'application/json', 'x-content-type-options': 'nosniff', ...headers })
  response.end(value)
}

async function body(request: IncomingMessage, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') throw new EmployeeAccessError(400)
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    signal.throwIfAborted()
    const bytes = chunk as Buffer
    size += bytes.length
    if (size > maxBytes) throw new EmployeeAccessError(413)
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
  const execution = config.promptPreset === undefined ? undefined : {
    preset: config.promptPreset,
    turns: new EmployeeTurns(ctx, owners, identity, config.promptPreset, config.timeoutMs, config.applicationPreviews),
  }
  if (execution === undefined) {
  // Host credentials do not bind a Frappe actor to queued employee work.
    ctx.on('agent/pre-step', ({ agent }, next) => owners.blocksExecution(agent.session.id)
      ? Promise.resolve({ kind: 'reject' as const }) : next())
    ctx.on('agent/request', ({ agent }, next) => {
      if (owners.blocksExecution(agent.session.id)) throw new EmployeeAccessError(401)
      return next()
    })
    ctx.effect(() => ctx.tools.guard(execution => execution.agent === undefined
    || owners.blocksExecution(execution.agent.session.id)
      ? 'Employee Agent execution is unavailable.' : undefined))
  }
  const access = new EmployeeSessionAccess(ctx.sessionController, owners, identity, async (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new EmployeeAccessError(503)
    await ctx.sessionPersistence.ensureMaterialized(session)
  }, execution, config.applicationPreviews === true ? identity : undefined, async (sessionId, signal) => {
    using observation = await ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
    return observation.cursor
  }, config.allowImages === true)
  const requests = new Map<Promise<void>, AbortController>()
  let closing = false

  async function handle(req: IncomingMessage, res: ServerResponse, abort: AbortController): Promise<void> {
    const destroy = (): void => { req.destroy(); res.destroy() }
    const began = Date.now()
    let endCause = 'completed'
    let beats = 0
    const expire = (): void => { endCause = 'server_deadline'; abort.abort() }
    const disconnected = (): void => { if (!res.writableEnded) endCause = 'downstream_closed'; abort.abort() }
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const timer = setTimeout(expire, employeeRequestDeadline(config, req.method, req.url))
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
          .parse(await identity.request('login', tickets[0], abort.signal))
        send(res, 303, undefined, { location: '/employee/status',
          'set-cookie': `${COOKIE}=${login.cookie}; Path=/; Max-Age=${String(login.maxAge)}; HttpOnly; Secure; SameSite=Strict` })
        return
      }
      const login = credential(req)
      if (url.search !== '') throw new EmployeeAccessError(400)
      if (url.pathname === '/employee/status' && req.method === 'GET') {
        await identity.authorize(login, abort.signal)
        send(res, 200, JSON.stringify({ access: execution === undefined ? 'read-preview' : 'read-only-turns',
          agentExecution: execution !== undefined }))
        return
      }
      if (req.method !== 'POST' || req.headers.origin !== config.publicOrigin) throw new EmployeeAccessError(400)
      if (url.pathname === '/employee/logout') {
        await identity.request('logout', login, abort.signal)
        execution?.turns.revoke(login)
        send(res, 204, undefined, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` })
        return
      }
      const operation = /^\/employee\/session\/(create|list|page|read|prompt|capabilities|review|confirm)$/u.exec(url.pathname)?.[1]
      if (operation === undefined) throw new EmployeeAccessError(404)
      const limit = operation === 'prompt' && config.allowImages === true ? (config.maxPromptBytes ?? 8192) : 8192
      const input = await body(req, abort.signal, limit)
      if (operation === 'prompt') {
        await identity.authorize(login, abort.signal)
        // JSON permits leading whitespace. Keep intermediaries active without
        // replaying a prompt or releasing any business data before authorization.
        heartbeat = setInterval(() => {
          if (res.destroyed || res.writableEnded || res.writableNeedDrain) return
          if (!res.headersSent) res.writeHead(200, {
            'content-type': 'application/json', 'cache-control': 'no-store, no-transform',
            'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff',
          })
          res.write(' '.repeat(8191) + '\n')
          beats++
        }, 10000)
        heartbeat.unref()
      }
      const result = await access.execute(operation, input, login, abort.signal)
      const serialized = JSON.stringify(result)
      if (Buffer.byteLength(serialized) > config.maxResponseBytes) throw new EmployeeAccessError(503)
      send(res, 200, serialized)
    } catch (error) {
      if (endCause === 'completed') endCause = 'handler_error'
      send(res, error instanceof EmployeeAccessError ? error.status : 503, '{"error":"employee access unavailable"}')
    } finally {
      clearTimeout(timer)
      if (heartbeat !== undefined) clearInterval(heartbeat)
      if (req.url === '/employee/session/prompt') void appendFile(
        '/home/zyd/frappe/logs/harness/prompt-diagnostic.jsonl',
        JSON.stringify({ time: new Date().toISOString(), durationMs: Date.now() - began,
          endCause, beats, headersSent: res.headersSent, ended: res.writableEnded }) + '\n',
        { mode: 0o600 }).catch(() => {})
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
