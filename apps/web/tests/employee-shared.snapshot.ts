/** Recorded authenticated read through one shipped Web process, never the Host prompt API. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas,
  formatSystemPromptSnapshot, formatToolSchemasSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import { disposeEmployeeFixtures, logs, startEmployee } from '../../cli/tests/profiles/employee-readonly/harness.ts'
import { sharedLogin, startSharedAuthority } from '../../cli/tests/profiles/employee-readonly/shared.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(() => disposeEmployeeFixtures(disposers))

it.skipIf(process.platform !== 'linux').each([false, true])('replays authenticated application access (previews=%s)', async (applicationPreviews) => {
  const directory = fileURLToPath(new URL(applicationPreviews
    ? '../../../snapshots/web/employee-shared-preview' : '../../../snapshots/web/employee-shared-readonly', import.meta.url))
  const mode = process.env.DSH_SNAPSHOT || 'replay'
  if (mode !== 'replay' && mode !== 'refresh') throw new Error('shared fixture supports keyless replay and refresh only')
  const file = join(directory, 'session.jsonl')
  const user = parseSessionLog(await readFile(file, 'utf8')).find(event => event.type === 'user/message')
  if (user?.type !== 'user/message') throw new Error('shared fixture lacks a user message')
  const content = user.data.content[0]
  if (content?.type !== 'text') throw new Error('shared fixture requires text')
  const authority = await startSharedAuthority(disposers)
  const host = await startEmployee(disposers, 'shared', 'http://127.0.0.1:1', undefined, file, true,
    { ...authority, applicationPreviews, allowImages: !applicationPreviews })
  const employee = await sharedLogin(host.origin, authority.ticket('teacher@example.test'))
  const created = await (await employee.raw('/employee/session/create')).json() as { sessionId: string }
  const image = await readFile(new URL('../../../snapshots/session/read-image/workspace/red.png', import.meta.url))
  const result = await employee.raw('/employee/session/prompt', { sessionId: created.sessionId, text: content.text,
    ...(!applicationPreviews ? { images: [{ type: 'image', mediaType: 'image/png', data: image.toString('base64') }] } : {}) })
  expect(result.status, host.safeLog()).toBe(200)
  const raw = await logs(host.home)
  expect(raw).toContain(applicationPreviews ? 'synthetic-preview' : 'synthetic-teacher')
  if (applicationPreviews) {
    const review: unknown = await (await employee.raw('/employee/session/review', { sessionId: created.sessionId })).json()
    expect(review).toMatchObject({ items: [{ state: 'awaiting_confirmation' }] })
    const confirm = { sessionId: created.sessionId, preview_id: 'synthetic-preview', digest: 'a'.repeat(64) }
    expect(await (await employee.raw('/employee/session/confirm', confirm)).json()).toEqual({ state: 'succeeded', replayed: false })
    expect(await (await employee.raw('/employee/session/confirm', confirm)).json()).toEqual({ state: 'succeeded', replayed: true })
  }
  expect(raw).not.toContain('synthetic-finance')
  expect(raw).not.toContain(employee.cookie.split('=')[1])
  expect(raw).not.toContain('teacher@example.test')
  const context = { sessionIds: [created.sessionId], cwd: host.root }
  const [normalized] = normalizeSessionSnapshots([raw], context)
  if (normalized === undefined) throw new Error('missing normalized shared session')
  const prompts = normalizedSystemPrompts(raw, context)
  const schemas = normalizedToolSchemas(raw, context)
  expect(prompts).toHaveLength(1)
  expect(schemas).toHaveLength(1)
  for (const [path, value] of [
    [file, normalized],
    [join(directory, 'system-prompt.expected.md'), formatSystemPromptSnapshot(prompts[0] as string)],
    [join(directory, 'tool-schemas.expected.json'), formatToolSchemasSnapshot(schemas[0] as unknown[])],
  ]) {
    if (path === undefined || value === undefined) throw new Error('missing snapshot artifact')
    if (mode === 'refresh') await writeFile(path, value)
    else expect(value, path).toBe(await readFile(path, 'utf8'))
  }
})
