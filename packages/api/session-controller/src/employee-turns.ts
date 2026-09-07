/** Request-owned employee execution; credentials never enter queued messages or session logs. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool, type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { SessionRequestId } from './types.ts'
import { EmployeeAccessError, type EmployeeIdentity, type EmployeePrincipal } from './employee-identity.ts'
import { type EmployeeOwners, sameEmployee } from './employee-owners.ts'

const TOOL = 'employee_frappe_read'
const query = z.object({
  operation: z.enum(['frappe_describe_doctype', 'frappe_list_documents', 'frappe_get_document']),
  arguments: z.record(z.string(), z.unknown()),
}).strict()

/**
 * Build the shared read schema for scoped registration and the generated tool catalog.
 * @param read - request-owned executor; it must enforce actor and query permissions itself.
 * @param timeoutMs - complete local tool deadline.
 * @returns the tool definition; registration alone grants no account authority.
 */
export function employeeReadTool(read: (input: unknown, execution: ToolExecution) => Promise<string>,
  timeoutMs: number): ToolDefinition {
  return defineTool({
    name: TOOL,
    description: 'Read permitted Frappe metadata, lists or one record using your current login. Never supply an account, site, SQL or executable code.',
    parameters: {
      operation: { type: 'string', required: true, description: 'frappe_describe_doctype, frappe_list_documents or frappe_get_document.' },
      arguments: { type: 'json', required: true, description: 'Structured query: doctype; optional fields, filters, order_by, limit, start; name for one record.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs,
    execute: read,
  })
}

interface Run {
  readonly credential: string
  readonly principal: EmployeePrincipal
  readonly requestId: SessionRequestId
  readonly signal: AbortSignal
  agent?: Agent
  turn?: number
  entered: boolean
  closed: boolean
  failed: boolean
}

/** Owns one non-resumable authenticated activity per session, through whole-agent quiescence. */
export class EmployeeTurns {
  private readonly runs = new Map<SessionId, Run>()

  /**
   * @param ctx - trusted Host services; employees cannot access their control API.
   * @param owners - immutable session owners, loaded before construction.
   * @param identity - login authority and permission-aware read executor.
   * @param preset - deployment-owned read-only preset, never supplied by the caller.
   * @param timeoutMs - bounded read-tool deadline.
   */
  constructor(private readonly ctx: Context, private readonly owners: EmployeeOwners,
    private readonly identity: EmployeeIdentity, preset: string, timeoutMs: number) {
    ctx.on('agent/created', ({ agent }) => {
      if (!owners.blocksExecution(agent.session.id)) return
      if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== preset) return
      ctx.effect(() => agent.ctx.tools.restrict({ allow: [] }))
      ctx.effect(() => agent.ctx.tools.register(employeeReadTool(async (input, execution) => {
        const run = this.requireRun(agent)
        if (execution.agent !== agent) throw new EmployeeAccessError(401)
        const parsed = query.safeParse(input)
        if (!parsed.success) throw new EmployeeAccessError(400)
        const signal = AbortSignal.any([run.signal, execution.signal])
        await this.check(run, signal)
        const result = await identity.read(run.credential, parsed.data.operation, parsed.data.arguments, signal)
        await this.check(run, signal)
        return JSON.stringify(result)
      }, timeoutMs)))
    })
    ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
      if (!owners.blocksExecution(agent.session.id)) return next()
      const run = this.runs.get(agent.session.id)
      if (run === undefined || run.failed || run.closed || run.signal.aborted) return { kind: 'reject' }
      const first = !run.entered
      const matches = first
        ? messages.length === 1 && messages[0]?.source.kind === 'user' && 'rpcId' in messages[0].source
          && messages[0].source.rpcId === run.requestId
        : run.agent === agent && run.turn === turn && messages.length === 0
      if (!matches || ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== preset) {
        run.failed = true
        return { kind: 'reject' }
      }
      try {
        await this.check(run, AbortSignal.any([signal, run.signal]))
        const decision = await next()
        if (decision.kind !== 'enter') { run.failed = true; return decision }
        if (decision.messages.length !== messages.length
          || decision.messages.some((message, index) => message !== messages[index])) {
          run.failed = true
          return { kind: 'reject' }
        }
        run.agent = agent
        run.turn = turn
        run.entered = true
        return decision
      } catch {
        // Authority failure or cancellation cannot admit a model step.
        run.failed = true
        return { kind: 'reject' }
      }
    })
    ctx.on('agent/request', async ({ agent, turn, signal }, next) => {
      if (!owners.blocksExecution(agent.session.id)) return next()
      const run = this.requireRun(agent)
      if (run.turn !== turn) throw new EmployeeAccessError(401)
      const result = await next()
      await this.check(run, AbortSignal.any([signal, run.signal]))
      return result
    })
    ctx.on('session/event', (session, event) => {
      const run = this.runs.get(session.id)
      if (run !== undefined && event.type === 'turn/end' && event.data.turn === run.turn) run.closed = true
    })
    ctx.effect(() => ctx.tools.guard((execution) => {
      const agent = execution.agent
      if (agent === undefined) return 'Employee Agent execution is unavailable.'
      if (!owners.blocksExecution(agent.session.id)) return undefined
      const run = this.runs.get(agent.session.id)
      return execution.name === TOOL && run?.agent === agent && run.entered && !run.closed
        && !run.failed && !run.signal.aborted ? undefined : 'Employee Agent execution is unavailable.'
    }))
  }

  private requireRun(agent: Agent): Run {
    const run = this.runs.get(agent.session.id)
    if (run === undefined || run.agent !== agent || !run.entered || run.closed || run.failed || run.signal.aborted)
      throw new EmployeeAccessError(401)
    return run
  }

  /**
   * Stop activities owned by a logged-out credential; replacement logins cannot revive them.
   * @param credential - opaque login revoked by the authority.
   */
  revoke(credential: string): void {
    for (const [id, run] of this.runs) {
      if (run.credential !== credential) continue
      run.failed = true
      this.ctx.agents.get(id)?.cancel({ kind: 'hook', reason: 'Employee login revoked.' })
    }
  }

  private async check(run: Run, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted()
      if (!sameEmployee(run.principal, await this.identity.authorize(run.credential, signal)))
        throw new EmployeeAccessError(401)
      signal.throwIfAborted()
    } catch {
      run.failed = true
      throw new EmployeeAccessError(401)
    }
  }

  /**
   * Queue a server-identified message and retain its authority only until that activity settles.
   * @param sessionId - session already checked against the verified owner.
   * @param text - caller text, never treated as authorization.
   * @param credential - request-private opaque login.
   * @param principal - verified caller pinned for the entire operation.
   * @param signal - HTTP lifetime; disconnect cancels and joins execution.
   * @returns settlement acknowledgement, not a claim of business success; read the owned history for results.
   */
  async prompt(sessionId: SessionId, text: string, credential: string,
    principal: EmployeePrincipal, signal: AbortSignal): Promise<{ settled: true; throughSeq: number }> {
    if (this.runs.has(sessionId)) throw new EmployeeAccessError(503)
    const run: Run = { credential, principal, signal, requestId: brandString<SessionRequestId>(randomUUID()),
      entered: false, closed: false, failed: false }
    this.runs.set(sessionId, run)
    const cancel = (): void => { this.ctx.agents.get(sessionId)?.cancel({ kind: 'hook', reason: 'Employee request ended.' }) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await this.check(run, signal)
      await this.owners.assertOwner(sessionId, principal)
      await this.ctx.sessionController.prompt({ sessionId, requestId: run.requestId,
        mode: 'queue', content: [{ type: 'text', text }] }, signal)
      if (signal.aborted) cancel()
      const agent = this.ctx.agents.get(sessionId)
      if (agent === undefined) throw new EmployeeAccessError(503)
      await agent.whenIdle()
      await this.check(run, signal)
      if (!run.entered || run.failed) throw new EmployeeAccessError(401)
      return { settled: true, throughSeq: agent.session.events.at(-1)?.seq ?? -1 }
    } finally {
      run.failed = true
      const agent = this.ctx.agents.get(sessionId)
      if (agent !== undefined && agent.status !== 'idle') { cancel(); await agent.whenIdle() }
      signal.removeEventListener('abort', cancel)
      this.runs.delete(sessionId)
    }
  }
}
