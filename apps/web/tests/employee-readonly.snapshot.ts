/** Recorded employee model boundary through the real shipped Web subprocess. */
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas,
  formatSystemPromptSnapshot, formatToolSchemasSnapshot,
} from '@deepseek-ai/dsh-session-snapshot'
import {
  disposeEmployeeFixtures, logs, startEmployee,
} from '../../cli/tests/profiles/employee-readonly/harness.ts'

import { sharedLogin, startSharedAuthority } from '../../cli/tests/profiles/employee-readonly/shared.ts'

const fixtureDir = fileURLToPath(new URL('../../../snapshots/web/employee-readonly', import.meta.url))
const fixtureFile = join(fixtureDir, 'session.jsonl')
const disposers: (() => Promise<unknown>)[] = []
afterEach(() => disposeEmployeeFixtures(disposers))

it('replays an unavailable shell call with only business-reader schemas and unchanged workspace', async () => {
  const mode = process.env.DSH_SNAPSHOT || 'replay'
  if (mode !== 'replay' && mode !== 'refresh') throw new Error('employee fixture supports keyless replay and refresh only')
  const fixture = await readFile(fixtureFile, 'utf8')
  const user = parseSessionLog(fixture).find(event => event.type === 'user/message')
  if (user?.type !== 'user/message') throw new Error('employee fixture lacks a user message')
  // Linux exercises the credential-free preset; socket reads have real-transport package tests.
  const authority = process.platform === 'linux' ? await startSharedAuthority(disposers) : undefined
  const host = await startEmployee(disposers, 'employee-fixture', 'http://127.0.0.1:1',
    undefined, fixtureFile, process.platform === 'linux', authority)
  const employee = authority === undefined ? undefined : await sharedLogin(host.origin, authority.ticket('teacher@example.test'))
  // The recording exercises the dedicated Host persona, not an employee-owned turn.
  const created = await host.rpc('session/create', { request: {} })
  expect(created).toMatchObject({ ok: true, value: { agentPreset: 'employee-readonly' } })
  const id = (created.value as { sessionId: string }).sessionId
  expect(await host.rpc('session/prompt', { request: {
    sessionId: id, requestId: 'employee-snapshot', mode: 'queue', content: user.data.content,
  } })).toMatchObject({ ok: true })
  await vi.waitFor(async () => {
    expect(await logs(host.home), host.safeLog()).toContain('"turn/end"')
  }, { timeout: 30000 })
  const raw = await logs(host.home)
  if (authority !== undefined && employee !== undefined) {
    const owned = await (await employee.raw('/employee/session/create')).json() as { sessionId: string }
    const endedBefore = raw.split('"turn/end"').length
    expect(await host.rpc('session/prompt', { request: {
      sessionId: owned.sessionId, requestId: 'unbound-employee-snapshot', mode: 'queue', content: user.data.content,
    } })).toMatchObject({ ok: true })
    await vi.waitFor(async () => {
      expect((await logs(host.home)).split('"turn/end"').length).toBeGreaterThan(endedBefore)
    }, { timeout: 30000 })
    expect((await logs(host.home)).split('"step/start"').length).toBe(raw.split('"step/start"').length)
    const other = await sharedLogin(host.origin, authority.ticket('finance@example.test'))
    expect((await other.raw('/employee/session/page', { sessionId: owned.sessionId, throughSeq: -1 })).status).toBe(404)
    expect(await (await other.raw('/employee/session/list')).json()).toEqual({ items: [] })
    expect(raw).not.toContain(employee.cookie.split('=')[1])
    expect(raw).not.toContain('teacher@example.test')
    await employee.raw('/employee/logout')
    expect((await employee.raw('/employee/session/list')).status).toBe(401)
  }
  const context = { sessionIds: [id], cwd: host.root }
  const [normalized] = normalizeSessionSnapshots([raw], context)
  if (normalized === undefined) throw new Error('employee session normalization failed')
  const prompts = normalizedSystemPrompts(raw, context)
  const schemas = normalizedToolSchemas(raw, context)
  expect(prompts).toHaveLength(1)
  expect(schemas).toHaveLength(1)
  const artifacts = [
    [fixtureFile, normalized],
    [join(fixtureDir, 'system-prompt.expected.md'), formatSystemPromptSnapshot(prompts[0] as string)],
    [join(fixtureDir, 'tool-schemas.expected.json'), formatToolSchemasSnapshot(schemas[0] as unknown[])],
  ] as const
  expect(raw).toContain('unknown tool')
  expect(raw).toContain('Employee scope test completed.')
  await expect(access(join(host.root, 'employee-escape-marker'))).rejects.toThrow()
  if (host.logout !== undefined) {
    await host.logout()
    expect((await host.raw('session/list', { _request: {} })).status).toBe(401)
  }
  for (const [path, content] of artifacts) {
    if (mode === 'refresh') await writeFile(path, content)
    else expect(content, path).toBe(await readFile(path, 'utf8'))
  }
})
