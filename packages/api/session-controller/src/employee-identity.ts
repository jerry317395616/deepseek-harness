/** Bounded IPC client for the trusted shared-runtime identity authority. */
import { createConnection } from 'node:net'
import { z } from 'zod'

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
   * Exchange or resolve an opaque login credential. No caller-selected account is accepted.
   * @param operation - authority operation, never a Frappe business method.
   * @param value - handoff or opaque login credential; must not enter logs.
   * @param signal - local cancellation, which cannot undo accepted remote work.
   * @returns parsed result; callers validate the operation-specific fields.
   */
  async request(operation: 'login' | 'authorize' | 'logout', value: string, signal: AbortSignal): Promise<unknown> {
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
        if (size > 8192) cancel()
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
}
