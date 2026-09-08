/** Bounded IPC client for the trusted shared-runtime identity authority. */
import { createConnection } from 'node:net'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Immutable site/account identity returned only by the trusted authority. */
export const principalSchema = z.object({
  site: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u),
  user: z.string().min(1).max(254).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)),
}).strict().readonly()

/** Verified account, not a browser or model argument. */
export type EmployeePrincipal = z.infer<typeof principalSchema>

/** Fixed public denial without credentials or backend diagnostics. */
export class EmployeeAccessError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 413 | 503) {
    super('employee access unavailable')
  }
}

/** Identity-authority calls carry credentials only over the private Unix channel. */
export class EmployeeIdentity {
  /**
   * @param socketPath - deployment-owned Unix socket with UID admission.
   * @param timeoutMs - deadline covering the entire connection and reply.
   */
  constructor(private readonly socketPath: string, private readonly timeoutMs: number) {}

  /**
   * Exchange a login, resolve identity or request a scoped read. No caller-selected account is accepted.
   * @param operation - authority operation, never a Frappe business method.
   * @param value - handoff, opaque login or credential-bound read request; must not enter logs.
   * @param signal - local cancellation, which cannot undo accepted remote work.
   * @returns parsed result; callers validate the operation-specific fields.
   */
  async request(operation: 'login' | 'authorize' | 'logout' | 'read' | 'application', value: unknown, signal: AbortSignal): Promise<unknown> {
    const payload = JSON.stringify({ version: 1, operation, value }) + '\n'
    if (Buffer.byteLength(payload) > 8192 || signal.aborted) throw new EmployeeAccessError(401)
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath })
      let size = 0
      let failed = false
      let ended = false
      const chunks: Buffer[] = []
      const cancel = (): void => { failed = true; socket.destroy() }
      const timer = setTimeout(cancel, this.timeoutMs)
      timer.unref()
      signal.addEventListener('abort', cancel, { once: true })
      socket.once('connect', () => { socket.end(payload) })
      socket.once('error', cancel)
      socket.once('end', () => { ended = true })
      socket.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > (operation === 'read' || operation === 'application' ? 262144 : 8192)) cancel()
        else chunks.push(chunk)
      })
      socket.once('close', () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        if (failed || !ended) { reject(new EmployeeAccessError(401)); return }
        try {
          const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
          const response = z.object({ ok: z.literal(true), result: z.unknown() }).strict().parse(parsed)
          resolve(response.result)
        } catch {
          reject(new EmployeeAccessError(401))
        }
      })
    })
  }

  /**
   * Resolve one still-enabled account for the current request.
   * @param credential - opaque browser login, never a user name.
   * @param signal - request lifetime.
   * @returns immutable verified principal, or a uniform denial.
   */
  async authorize(credential: string, signal: AbortSignal): Promise<EmployeePrincipal> {
    const parsed = principalSchema.safeParse(await this.request('authorize', credential, signal))
    if (!parsed.success) throw new EmployeeAccessError(401)
    return parsed.data
  }

  /**
   * Read through the login's pinned Frappe identity; the authority validates scope and permissions.
   * @param credential - request-owned opaque login; never persisted or supplied by a model.
   * @param operation - one of the authority's three read-only operations.
   * @param arguments_ - untrusted structured query without any actor or site selector.
   * @param signal - request lifetime; remote read workers also have a fixed deadline.
   * @returns bounded result after the authority revalidates the same login.
   */
  async read(credential: string, operation: string, arguments_: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    return this.request('read', { credential, operation, arguments: arguments_ }, signal)
  }

  /**
   * Forward a session-owned application request; business rules belong to the authority.
   * @param credential - private verified login, never model input.
   * @param sessionId - session whose ownership the caller has verified.
   * @param action - preview never executes; confirm is available only to the browser route.
   * @param arguments_ - untrusted values validated again by the application.
   * @param signal - request lifetime; disconnect cannot undo accepted confirmation.
   * @returns bounded application data; confirmation outcomes must not be inferred from HTTP failure.
   */
  async application(credential: string, sessionId: SessionId,
    action: 'capabilities' | 'preview' | 'review' | 'confirm',
    arguments_: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    return this.request('application', { credential, sessionId, action, arguments: arguments_ }, signal)
  }
}
