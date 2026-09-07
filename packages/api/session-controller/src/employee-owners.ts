/** Durable immutable ownership records, separate from model-visible session content. */
import { constants } from 'node:fs'
import { link, mkdir, open, opendir, realpath, stat, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EmployeeAccessError, principalSchema, type EmployeePrincipal } from './employee-identity.ts'

const ownerSchema = z.object({ version: z.literal(1), sessionId: z.string().min(1).max(128),
  principal: principalSchema }).strict()

/**
 * Owner comparisons always include the Frappe site as well as the account.
 * @param left - first verified principal.
 * @param right - second verified principal.
 * @returns whether both site and account match.
 */
export function sameEmployee(left: EmployeePrincipal, right: EmployeePrincipal): boolean {
  return left.site === right.site && left.user === right.user
}

/** Append-only ownership store. Missing legacy ownership never grants access. */
export class EmployeeOwners {
  private readonly reserved = new Set<string>()
  /**
   * @param directory - private canonical directory reserved for ownership records.
   * @param scanLimit - maximum records scanned before denying a list operation.
   */
  constructor(private readonly directory: string, private readonly scanLimit: number) {}

  /** Validate the directory before mounting any employee HTTP route. */
  async initialize(): Promise<void> {
    if (process.platform !== 'linux' || !isAbsolute(this.directory)) throw new EmployeeAccessError(503)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await stat(this.directory)
    if (await realpath(this.directory) !== this.directory || !info.isDirectory()
      || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new EmployeeAccessError(503)
    let count = 0
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue
      if (++count > this.scanLimit) throw new EmployeeAccessError(503)
      const row = await this.readPath(join(this.directory, entry.name))
      if (row !== undefined) this.reserved.add(row.sessionId)
    }
  }

  /**
   * Identify employee sessions before executing an Agent or tool, including failed reservations.
   * The deployment must not edit ownership files while this store is active.
   * @param sessionId - session belonging to the execution, not an actor supplied in tool arguments.
   * @returns whether the session lacks an admitted employee execution path.
   */
  blocksExecution(sessionId: SessionId): boolean {
    return this.reserved.has(sessionId)
  }

  private path(sessionId: string): string {
    return join(this.directory, createHash('sha256').update(sessionId).digest('hex') + '.json')
  }

  /**
   * Reserve a server-generated session for an account before session creation.
   * @param sessionId - new server-generated identity, never an adopted client ID.
   * @param principal - identity resolved for this operation.
   * @returns after durable atomic publication; rejects on any existing owner.
   */
  async reserve(sessionId: SessionId, principal: EmployeePrincipal): Promise<void> {
    if (!this.reserved.has(sessionId) && this.reserved.size >= this.scanLimit) throw new EmployeeAccessError(503)
    this.reserved.add(sessionId)
    const temporary = join(this.directory, '.' + randomUUID() + '.tmp')
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      await handle.writeFile(JSON.stringify({ version: 1, sessionId, principal }) + '\n', 'utf8')
      await handle.sync()
      await link(temporary, this.path(sessionId))
    } finally {
      await handle.close()
      await unlink(temporary)
    }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
  }

  private async readPath(path: string): Promise<z.infer<typeof ownerSchema> | undefined> {
    let handle
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new EmployeeAccessError(503)
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new EmployeeAccessError(503)
      const bytes = Buffer.alloc(4097)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 4096) throw new EmployeeAccessError(503)
      const row = ownerSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))))
      if (this.path(row.sessionId) !== path) throw new EmployeeAccessError(503)
      return row
    } finally { await handle.close() }
  }

  /**
   * Reject another account's or an unowned session with the same not-found response.
   * @param sessionId - requested session identity.
   * @param principal - verified caller.
   */
  async assertOwner(sessionId: SessionId, principal: EmployeePrincipal): Promise<void> {
    const row = await this.readPath(this.path(sessionId))
    if (row === undefined || !sameEmployee(row.principal, principal)) throw new EmployeeAccessError(404)
  }

  /**
   * Enumerate only IDs assigned to this account; never expose another owner's metadata.
   * @param principal - verified caller.
   * @returns owned identities; failed reservations may lack a corresponding session.
   */
  async ownedIds(principal: EmployeePrincipal): Promise<ReadonlySet<string>> {
    const result = new Set<string>()
    let count = 0
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue
      if (++count > this.scanLimit) throw new EmployeeAccessError(503)
      const row = await this.readPath(join(this.directory, entry.name))
      if (row !== undefined && sameEmployee(row.principal, principal)) result.add(row.sessionId)
    }
    return result
  }
}
