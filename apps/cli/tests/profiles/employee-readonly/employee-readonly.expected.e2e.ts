/** Two real Web processes exercising the opt-in employee composition without production data. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { disposeEmployeeFixtures, logs, startEmployee as launchEmployee } from './harness.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(() => disposeEmployeeFixtures(disposers))
const startEmployee = (label: string, baseURL: string, existingRoot?: string) =>
  launchEmployee(disposers, label, baseURL, existingRoot)

describe('employee readonly Web profile', () => {
  it('restricts presets, model tools and RPCs while isolating durable sessions between Hosts', async () => {
    const provider = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'], repeatLast: true,
      toolName: 'bash', toolArguments: '{"command":"touch employee-escape-marker"}',
      successText: 'Employee scope test completed.',
    })
    disposers.push(() => provider.close())
    const [a, b] = await Promise.all([
      startEmployee('employee-a', provider.baseURL),
      startEmployee('employee-b', provider.baseURL),
    ])
    const created = await a.rpc('session/create', { request: {} })
    expect(created, JSON.stringify(created) + a.safeLog()).toMatchObject({ ok: true, value: { agentPreset: 'employee-readonly' } })
    const id = (created.value as { sessionId: string }).sessionId
    expect(await a.rpc('agentPresets/list')).toMatchObject({
      ok: true, value: { authorable: false, presets: [{ id: 'employee-readonly', trust: 'system' }] },
    })
    expect(await a.rpc('session/create', { request: { agentPreset: 'standard' } }))
      .toMatchObject({ ok: false, error: { code: 'agent-preset/not-found' } })
    expect(await a.rpc('session/create', { request: { agentPreset: '../standard' } }))
      .toMatchObject({ ok: false, error: { code: 'agent-preset/not-found' } })

    for (const method of ['settings/update', 'settings/replace', 'settings/mutate',
      'agentPresets/copy', 'agentPresets/deletePreset', 'agentPresets/select',
      'session/openWorkspacePath', 'session/selectModel', 'session/fork',
      'workspace/create', '$events/result']) {
      expect(await a.rpc(method)).toMatchObject({ ok: false, error: { code: 'gateway/forbidden' } })
    }
    expect((await b.raw('session/list', { _request: {} }, a.cookie)).status).toBe(401)
    expect(await b.rpc('session/page', {
      request: { address: { kind: 'session', sessionId: id }, throughSeq: 100 },
    })).toMatchObject({ ok: false, error: { code: 'session/not-found' } })

    const socket = new WebSocket(a.origin.replace('http:', 'ws:') + '/api/remote.mux',
      { headers: { ...a.headers, cookie: a.cookie } })
    disposers.push(async () => {
      if (socket.readyState === WebSocket.CLOSED) return
      const closed = once(socket, 'close')
      socket.terminate()
      await closed
    })
    const frames: Record<string, unknown>[] = []
    socket.on('message', (data) => {
      frames.push(JSON.parse((Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString('utf8')) as Record<string, unknown>)
    })
    await once(socket, 'open')
    socket.send(JSON.stringify({
      type: 'open', streamId: 'blocked', endpoint: 'settings/update', payload: { args: {} },
    }))
    await vi.waitFor(() => {
      expect(frames.find(frame => frame.streamId === 'blocked'))
        .toMatchObject({ type: 'error', error: { code: 'gateway/forbidden' } })
    })
    expect(await a.rpc('session/prompt', { request: {
      sessionId: id, requestId: 'employee-scope-fixture', mode: 'queue',
      content: [{ type: 'text', text: 'Try the unavailable shell, then report the refusal.' }],
    } })).toEqual({ ok: true, value: { accepted: true } })
    await vi.waitFor(async () => {
      expect(await logs(a.home)).toContain('"turn/end"')
    }, { timeout: 30000 })
    expect(provider.requests.length).toBe(2)
    const request = provider.requests[0]?.body as {
      tools: { function: { name: string } }[]
    }
    expect(request.tools.map(tool => tool.function.name).sort()).toEqual([
      'native_bench_frappe_describe_doctype',
      'native_bench_frappe_get_document',
      'native_bench_frappe_list_documents',
    ])
    const saved = await logs(a.home)
    expect(saved).toContain('unknown tool')
    expect(saved).toContain('Employee scope test completed.')
    await expect(access(join(a.root, 'employee-escape-marker'))).rejects.toThrow()
    expect(await b.rpc('session/list', { _request: {} })).toEqual({ ok: true, value: { items: [] } })
    if (a.logout !== undefined) {
      const closed = once(socket, 'close')
      await a.logout()
      await closed
      expect((await a.raw('session/list', { _request: {} })).status).toBe(401)
      expect(await b.rpc('session/list', { _request: {} })).toEqual({ ok: true, value: { items: [] } })
    }
    // A new process must reconstruct the same preset and transcript, not another Host's directory.
    await a.stop()
    const resumed = await startEmployee('employee-a', provider.baseURL, a.root)
    const listing = await resumed.rpc('session/list', { _request: {} })
    expect(JSON.stringify(listing)).toContain(id)
    expect(await resumed.rpc('session/create', { request: { sessionId: id } }))
      .toMatchObject({ ok: true, value: { sessionId: id, agentPreset: 'employee-readonly' } })
    const restored = await logs(resumed.home)
    expect(restored.startsWith(saved)).toBe(true)
    expect(restored.slice(saved.length).trim().split('\n').map(line => JSON.parse(line) as object))
      .toEqual([expect.objectContaining({ type: 'session/end-seed', data: {} })])
  })
})
