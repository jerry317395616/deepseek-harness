/** Same-process account ownership and durable denial regressions. */
import { mkdtemp, rm, readdir, readFile, writeFile, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '../src/types.ts'
import { EmployeeSessionAccess } from '../src/employee-access.ts'
import { EmployeeOwners } from '../src/employee-owners.ts'
import { EmployeeAccessError, type EmployeePrincipal } from '../src/employee-identity.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const a = { site: 'example.test', user: 'teacher@example.test' }
const b = { site: 'example.test', user: 'finance@example.test' }
const signal = new AbortController().signal

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-account-owners-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const owners = new EmployeeOwners(root, 100)
  await owners.initialize()
  const accounts = new Map<string, EmployeePrincipal>([['a', a], ['b', b]])
  const controller = {
    create: vi.fn(async ({ sessionId }: { sessionId?: SessionId }) => {
      if (sessionId === undefined) throw new Error('server identity required')
      rows.push({ sessionId, updatedAt: 1, running: false, blank: true })
      return { sessionId }
    }),
    list: vi.fn(async () => ({ items: rows })),
    page: vi.fn(async () => ({ records: [], hasMore: false })),
  }
  const rows: SessionSummary[] = []
  const identity = { authorize: vi.fn(async (cookie: string) => {
    const principal = accounts.get(cookie)
    if (principal === undefined) throw new EmployeeAccessError(401)
    return principal
  }) }
  const materialize = vi.fn(async () => {})
  const access = new EmployeeSessionAccess(controller, owners, identity, materialize)
  return { root, owners, accounts, controller, rows, identity, access, materialize }
}

describe.skipIf(process.platform !== 'linux')('shared session access', () => {
  it('creates two concurrent account-owned sessions and rejects cross-account reads at the executor', async () => {
    const f = await fixture()
    const [left, right] = await Promise.all([
      f.access.execute('create', {}, 'a', signal), f.access.execute('create', {}, 'b', signal),
    ]) as { sessionId: SessionId }[]
    expect(left?.sessionId).not.toBe(right?.sessionId)
    const aId = left?.sessionId as SessionId
    const bId = right?.sessionId as SessionId
    expect(await f.access.execute('list', {}, 'a', signal)).toMatchObject({ items: [{ sessionId: aId }] })
    expect(await f.access.execute('list', {}, 'b', signal)).toMatchObject({ items: [{ sessionId: bId }] })
    const read = { sessionId: aId, throughSeq: -1 }
    expect(await f.access.execute('page', read, 'a', signal)).toEqual({ records: [], hasMore: false })
    await expect(f.access.execute('page', read, 'b', signal)).rejects.toMatchObject({ status: 404 })
    expect(f.controller.page).toHaveBeenCalledTimes(1)
    expect(f.materialize.mock.calls).toHaveLength(2)
  })

  it('never adopts client-selected sessions, users, paths, presets or legacy ownership', async () => {
    const f = await fixture()
    const unowned = brandString<SessionId>('session-' + randomUUID())
    f.rows.push({ sessionId: unowned, updatedAt: 1, running: false, blank: false })
    for (const input of [{ sessionId: unowned }, { user: b.user }, { cwd: '/' }, { agentPreset: 'standard' }]) {
      await expect(f.access.execute('create', input, 'a', signal)).rejects.toMatchObject({ status: 400 })
    }
    expect(f.controller.create).not.toHaveBeenCalled()
    expect(await f.access.execute('list', {}, 'a', signal)).toEqual({ items: [] })
    await expect(f.access.execute('page', { sessionId: unowned, throughSeq: -1 }, 'a', signal))
      .rejects.toMatchObject({ status: 404 })
    for (const operation of ['prompt', 'follow', 'search', 'attachments', 'update', '$events']) {
      await expect(f.access.execute(operation, {}, 'a', signal)).rejects.toMatchObject({ status: 404 })
    }
  })

  it('uses site and account together and restores immutable owners from disk', async () => {
    const f = await fixture()
    const created = await f.access.execute('create', {}, 'a', signal) as { sessionId: SessionId }
    const restored = new EmployeeOwners(f.root, 100)
    await restored.initialize()
    await restored.assertOwner(created.sessionId, a)
    await expect(restored.assertOwner(created.sessionId, { ...a, site: 'other.test' }))
      .rejects.toMatchObject({ status: 404 })
    await expect(restored.reserve(created.sessionId, b)).rejects.toMatchObject({ code: 'EEXIST' })
    await restored.assertOwner(created.sessionId, a)
    expect((await readdir(f.root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('does not release results after logout or account reassignment during an operation', async () => {
    const f = await fixture()
    const id = brandString<SessionId>('session-' + randomUUID())
    await f.owners.reserve(id, a)
    f.controller.page.mockImplementationOnce(async () => {
      f.accounts.delete('a')
      return { records: [], hasMore: false }
    })
    await expect(f.access.execute('page', { sessionId: id, throughSeq: -1 }, 'a', signal))
      .rejects.toMatchObject({ status: 401 })
    f.accounts.set('a', a)
    f.controller.list.mockImplementationOnce(async () => {
      f.accounts.set('a', b)
      return { items: [] }
    })
    await expect(f.access.execute('list', {}, 'a', signal)).rejects.toMatchObject({ status: 401 })
  })

  it('bounds scans and refuses malformed, linked or publicly readable owner files', async () => {
    const f = await fixture()
    const id = brandString<SessionId>('session-' + randomUUID())
    const other = brandString<SessionId>('session-' + randomUUID())
    await f.owners.reserve(id, a)
    await f.owners.reserve(other, b)
    await expect(new EmployeeOwners(f.root, 1).ownedIds(a)).rejects.toMatchObject({ status: 503 })
    const first = join(f.root, (await readdir(f.root))[0] as string)
    const original = await readFile(first, 'utf8')
    await writeFile(first, '{"version":2}')
    await expect(f.owners.ownedIds(a)).rejects.toThrow()
    await writeFile(first, 'x'.repeat(4097))
    await expect(f.owners.ownedIds(a)).rejects.toMatchObject({ status: 503 })
    const swapped = JSON.parse(original) as { sessionId: string }
    swapped.sessionId = 'session-' + randomUUID()
    await writeFile(first, JSON.stringify(swapped))
    await expect(f.owners.ownedIds(a)).rejects.toMatchObject({ status: 503 })
    await writeFile(first, original)
    await chmod(first, 0o644)
    await expect(f.owners.ownedIds(a)).rejects.toMatchObject({ status: 503 })
    await chmod(first, 0o600)
    const linked = join(f.root, 'linked.json')
    await symlink(first, linked)
    await expect(f.owners.ownedIds(a)).rejects.toMatchObject({ status: 503 })
  })

  it('rejects non-private roots and ignores unpublished reservation files', async () => {
    const f = await fixture()
    await expect(new EmployeeOwners('relative-path', 100).initialize()).rejects.toMatchObject({ status: 503 })
    await chmod(f.root, 0o755)
    await expect(new EmployeeOwners(f.root, 100).initialize()).rejects.toMatchObject({ status: 503 })
    await chmod(f.root, 0o700)
    await writeFile(join(f.root, '.unpublished.tmp'), 'not an owner')
    expect(await f.owners.ownedIds(a)).toEqual(new Set())
  })
})
