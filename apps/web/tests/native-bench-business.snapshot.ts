/** Recorded model boundary through the hardened shipped Web process; no provider credentials. */
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas,
  formatSystemPromptSnapshot, formatToolSchemasSnapshot,
} from '@deepseek-ai/dsh-session-snapshot'
import { disposeEmployeeFixtures, logs, startEmployee } from '../../cli/tests/profiles/employee-readonly/harness.ts'

const fixtureDir = fileURLToPath(new URL('../../../snapshots/web/native-bench-business', import.meta.url))
const fixtureFile = join(fixtureDir, 'session.jsonl')
const disposers: (() => Promise<unknown>)[] = []
afterEach(() => disposeEmployeeFixtures(disposers))

it('freezes schema, shell and configuration admission in a real Web conversation', async () => {
  const mode = process.env.DSH_SNAPSHOT || 'replay'
  if (mode !== 'replay' && mode !== 'refresh') throw new Error('business fixture supports keyless replay and refresh only')
  const user = parseSessionLog(await readFile(fixtureFile, 'utf8')).find(event => event.type === 'user/message')
  if (user?.type !== 'user/message') throw new Error('business fixture lacks a user message')
  const host = await startEmployee(disposers, 'business-fixture', 'http://127.0.0.1:1',
    undefined, fixtureFile, false, undefined, true)
  const created = await host.rpc('session/create', { request: {} })
  expect(created, host.safeLog()).toMatchObject({ ok: true, value: { agentPreset: 'native-bench-business' } })
  const id = (created.value as { sessionId: string }).sessionId
  for (const method of ['settings/update', 'settings/replace', 'settings/mutate',
    'agentPresets/copy', 'agentPresets/deletePreset', 'agentPresets/select',
    'session/openWorkspacePath', 'session/selectModel', 'workspace/create']) {
    expect(await host.rpc(method)).toMatchObject({ ok: false, error: { code: 'gateway/forbidden' } })
  }
  expect(await host.rpc('session/prompt', { request: {
    sessionId: id, requestId: 'business-snapshot', mode: 'queue', content: user.data.content,
  } })).toMatchObject({ ok: true })
  await vi.waitFor(async () => {
    expect(await logs(host.home), host.safeLog()).toContain('"turn/end"')
  }, { timeout: 30000 })
  const raw = await logs(host.home)
  expect(raw).toContain('当前服务只允许已上线的受控业务操作')
  expect(raw).toContain('Employee scope test completed.')
  await expect(access(join(host.root, 'employee-escape-marker'))).rejects.toThrow()
  const context = { sessionIds: [id], cwd: host.root }
  const [normalized] = normalizeSessionSnapshots([raw], context)
  if (normalized === undefined) throw new Error('business session normalization failed')
  const prompts = normalizedSystemPrompts(raw, context)
  const schemas = normalizedToolSchemas(raw, context)
  expect(prompts).toHaveLength(1)
  expect(schemas).toHaveLength(1)
  expect(prompts[0]).toContain('DocType')
  expect(schemas[0]).not.toContainEqual(expect.objectContaining({ name: 'bash' }))
  const artifacts = [
    [fixtureFile, normalized],
    [join(fixtureDir, 'system-prompt.expected.md'), formatSystemPromptSnapshot(prompts[0] as string)],
    [join(fixtureDir, 'tool-schemas.expected.json'), formatToolSchemasSnapshot(schemas[0] as unknown[])],
  ] as const
  for (const [path, content] of artifacts) {
    if (mode === 'refresh') await writeFile(path, content)
    else expect(content, path).toBe(await readFile(path, 'utf8'))
  }
})
