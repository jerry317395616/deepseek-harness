/** Deterministic authority changes at the pre-step, request and tool boundaries. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { SessionPromptRequest } from '../src/types.ts'
import { EmployeeTurns } from '../src/employee-turns.ts'
import { EmployeeAccessError, type EmployeeIdentity } from '../src/employee-identity.ts'
import type { EmployeeOwners } from '../src/employee-owners.ts'

function fixture() {
  const principal = { site: 'example.test', user: 'teacher@example.test' }
  const id = 'session-11111111-1111-1111-1111-111111111111' as SessionId
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const definitions: ToolDefinition[] = []
  const effects: (() => unknown)[] = []
  let enabled = true
  let entered!: () => void
  let finish!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { finish = resolve })
  let activity: Promise<void> = Promise.resolve()
  const agent = { id, session: { id, events: [] }, status: 'idle',
    whenIdle: () => activity, cancel: () => { finish() },
    ctx: { tools: { restrict: () => () => {}, register: (tool: ToolDefinition) => {
      definitions.push(tool)
      return () => { definitions.splice(definitions.indexOf(tool), 1) }
    } } },
  } as unknown as Agent
  const identity = { authorize: vi.fn(async () => {
    if (!enabled) throw new EmployeeAccessError(401)
    return principal
  }), read: vi.fn(async () => ({ rows: ['own-record'] })) }
  const owners = { blocksExecution: (candidate: SessionId) => candidate === id, assertOwner: vi.fn(async () => {}) }
  let requestId = ''
  const ctx = {
    on(name: string, callback: (...args: unknown[]) => unknown) { handlers.set(name, callback) },
    effect(callback: () => () => unknown) { effects.push(callback()) },
    agents: { get: () => agent },
    tools: { guard: () => () => {} },
    sessionProjections: { stateOf: () => 'shared' },
    sessionController: { async prompt(request: SessionPromptRequest) {
      requestId = request.requestId
      activity = gate
      entered()
      return { accepted: true }
    } },
  } as unknown as Context
  const turns = new EmployeeTurns(ctx, owners as unknown as EmployeeOwners,
    identity as unknown as EmployeeIdentity, 'shared', 1000)
  handlers.get('agent/created')?.({ agent })
  async function step(turn: number, rpcId?: string) {
    const messages = rpcId === undefined ? [] : [{ source: { kind: 'user', rpcId } }]
    return handlers.get('agent/pre-step')?.({ agent, turn, step: 1, messages, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages }))
  }
  return { turns, principal, id, ready, finish, step, agent, identity, definitions,
    disable() { enabled = false },
    requestId: () => requestId,
    request: () => handlers.get('agent/request')?.({ agent, turn: 1, signal: new AbortController().signal }, async () => ({})),
    async dispose() { finish(); await activity; for (const effect of effects.reverse()) await effect() },
  }
}

describe('request-owned employee turns', () => {
  it('requires the admitted message and exact turn, and removes the scoped tool on disposal', async () => {
    const f = fixture()
    try {
      expect(await f.step(1, 'unowned-host')).toEqual({ kind: 'reject' })
      const pending = f.turns.prompt(f.id, 'Read records', 'opaque', f.principal, new AbortController().signal)
      const outcome = expect(pending).rejects.toMatchObject({ status: 401 })
      await f.ready
      expect(await f.step(1, f.requestId())).toMatchObject({ kind: 'enter' })
      expect(await f.step(2)).toEqual({ kind: 'reject' })
      f.finish()
      await outcome
    } finally { await f.dispose() }
    expect(f.definitions).toEqual([])
  })

  it('revalidates before a model request and does not admit a disabled account', async () => {
    const f = fixture()
    try {
      const pending = f.turns.prompt(f.id, 'Read records', 'opaque', f.principal, new AbortController().signal)
      const outcome = expect(pending).rejects.toMatchObject({ status: 401 })
      await f.ready
      expect(await f.step(1, f.requestId())).toMatchObject({ kind: 'enter' })
      f.disable()
      await expect(f.request()).rejects.toMatchObject({ status: 401 })
      f.finish()
      await outcome
      expect(f.identity.read).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('checks the tool body even for direct callers and discards results after revocation', async () => {
    const f = fixture()
    try {
      const pending = f.turns.prompt(f.id, 'Read records', 'opaque', f.principal, new AbortController().signal)
      const outcome = expect(pending).rejects.toMatchObject({ status: 401 })
      await f.ready
      expect(await f.step(1, f.requestId())).toMatchObject({ kind: 'enter' })
      const definition = f.definitions[0]
      if (definition === undefined) throw new Error('shared tool not registered')
      const execute = definition.execute.bind(definition)
      const input = { operation: 'frappe_list_documents', arguments: { doctype: 'Student' } }
      const execution = { agent: f.agent, signal: new AbortController().signal } as ToolRunContext
      await expect(execute(input, { ...execution, agent: { ...f.agent } })).rejects.toMatchObject({ status: 401 })
      await expect(execute({ ...input, operation: 'frappe_apply_document_update' }, execution))
        .rejects.toMatchObject({ status: 400 })
      f.identity.read.mockImplementationOnce(async () => { f.disable(); return { rows: ['must-not-escape'] } })
      await expect(execute(input, execution)).rejects.toMatchObject({ status: 401 })
      expect(f.identity.read).toHaveBeenCalledTimes(1)
      f.finish()
      await outcome
      await expect(execute(input, execution)).rejects.toMatchObject({ status: 401 })
    } finally { await f.dispose() }
  })
})
