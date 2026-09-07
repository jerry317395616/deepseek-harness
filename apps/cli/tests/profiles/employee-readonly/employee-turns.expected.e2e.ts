/** Authenticated read turns through the shipped Web process and real tool pipeline. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { disposeEmployeeFixtures, logs, startEmployee } from './harness.ts'
import { sharedLogin, sharedRequest, startSharedAuthority } from './shared.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(() => disposeEmployeeFixtures(disposers))

describe.skipIf(process.platform !== 'linux')('shared employee read turns', () => {
  it('keeps concurrent accounts separate and joins logout and client cancellation before reusing a session', async () => {
    const provider = await startMockLlmServer({ sequence: ['stall', 'stall', 'success'], repeatLast: true })
    disposers.push(() => provider.close())
    const authority = await startSharedAuthority(disposers)
    const host = await startEmployee(disposers, 'shared', provider.baseURL, undefined, undefined, true, authority)
    const a = await sharedLogin(host.origin, authority.ticket('teacher@example.test'))
    const b = await sharedLogin(host.origin, authority.ticket('finance@example.test'))
    const left = await (await a.raw('/employee/session/create')).json() as { sessionId: string }
    const right = await (await b.raw('/employee/session/create')).json() as { sessionId: string }
    const path = '/employee/session/prompt'
    const first = a.raw(path, { sessionId: left.sessionId, text: 'Read my students.' })
    const abort = new AbortController()
    const second = expect(sharedRequest(host.origin, path, b.cookie,
      { sessionId: right.sessionId, text: 'Read my students.' }, abort.signal)).rejects.toThrow()
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(2) }, { timeout: 5000 })
    expect((await a.raw(path, { sessionId: left.sessionId, text: 'Overlap.' })).status).toBe(503)
    expect((await a.raw('/employee/logout')).status).toBe(204)
    expect((await first).status).toBe(401)
    abort.abort()
    await second
    await vi.waitFor(async () => {
      expect((await logs(host.home)).split('"turn/end"')).toHaveLength(3)
    }, { timeout: 5000 })
    const again = await sharedLogin(host.origin, authority.ticket('teacher@example.test'))
    expect((await again.raw(path, { sessionId: left.sessionId, text: 'Fresh authorized turn.' })).status).toBe(200)
    expect(provider.requests).toHaveLength(3)
  })

  it('binds tool results to each login, rejects forged actors and keeps credentials out of history', async () => {
    const provider = await startMockLlmServer({ sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
      repeatLast: true, toolName: 'employee_frappe_read',
      toolArguments: JSON.stringify({ operation: 'frappe_list_documents', arguments: { doctype: 'Student' } }),
      successText: 'Scoped query completed.',
    })
    disposers.push(() => provider.close())
    const authority = await startSharedAuthority(disposers)
    const host = await startEmployee(disposers, 'shared', provider.baseURL, undefined, undefined, true, authority)
    const a = await sharedLogin(host.origin, authority.ticket('teacher@example.test'))
    const b = await sharedLogin(host.origin, authority.ticket('finance@example.test'))
    const left = await (await a.raw('/employee/session/create')).json() as { sessionId: string }
    const right = await (await b.raw('/employee/session/create')).json() as { sessionId: string }
    const path = '/employee/session/prompt'
    expect((await b.raw(path, { sessionId: left.sessionId, text: 'List students.' })).status).toBe(404)
    for (const extra of [{ user: 'Administrator' }, { mode: 'steer' }, { agentPreset: 'standard' }])
      expect((await a.raw(path, { sessionId: left.sessionId, text: 'List students.', ...extra })).status).toBe(400)
    for (const [client, id, own, foreign] of [
      [a, left.sessionId, 'synthetic-teacher', 'synthetic-finance'],
      [b, right.sessionId, 'synthetic-finance', 'synthetic-teacher'],
    ] as const) {
      const response = await client.raw(path, { sessionId: id, text: 'List students.' })
      expect(response.status, host.safeLog() + await response.clone().text()).toBe(200)
      const receipt = await response.json() as { settled: boolean; throughSeq: number }
      expect(receipt.settled).toBe(true)
      const history = await (await client.raw('/employee/session/page', { sessionId: id, throughSeq: receipt.throughSeq })).text()
      expect(history).toContain(own)
      expect(history).not.toContain(foreign)
    }
    expect(provider.requests).toHaveLength(4)
    for (const request of provider.requests) {
      const body = request.body as { tools: { function: { name: string } }[] }
      expect(body.tools.map(tool => tool.function.name)).toEqual(['employee_frappe_read'])
    }
    const saved = await logs(host.home)
    expect(saved).toContain('"tool/call"')
    expect(saved).toContain('"tool/result"')
    expect(saved).not.toContain(a.cookie.split('=')[1])
    expect(saved).not.toContain(b.cookie.split('=')[1])
    await a.raw('/employee/logout')
    expect((await a.raw(path, { sessionId: left.sessionId, text: 'List students.' })).status).toBe(401)
    await authority.disable('finance@example.test')
    expect((await b.raw(path, { sessionId: right.sessionId, text: 'List students.' })).status).toBe(401)
    expect(provider.requests).toHaveLength(4)
  })
})
