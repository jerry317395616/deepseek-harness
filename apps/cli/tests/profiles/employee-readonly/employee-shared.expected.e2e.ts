/** Two accounts against one real dsh Web process; no live Frappe records or model calls. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { disposeEmployeeFixtures, startEmployee } from './harness.ts'
import { sharedLogin, sharedRequest, startSharedAuthority } from './shared.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(() => disposeEmployeeFixtures(disposers))

describe.skipIf(process.platform !== 'linux')('single Harness account-owned session preview', () => {
  it('isolates concurrent accounts, denies alternate carriers, restores ownership and revokes access', async () => {
    const authority = await startSharedAuthority(disposers)
    const host = await startEmployee(disposers, 'shared', 'http://127.0.0.1:1', undefined,
      undefined, true, authority)
    const ticket = authority.ticket('teacher@example.test')
    const [a, b] = await Promise.all([
      sharedLogin(host.origin, ticket), sharedLogin(host.origin, authority.ticket('finance@example.test')),
    ])
    const [left, right] = await Promise.all([
      a.raw('/employee/session/create'), b.raw('/employee/session/create'),
    ])
    expect(left.status, host.safeLog()).toBe(200)
    expect(right.status, host.safeLog()).toBe(200)
    const aId = (await left.json() as { sessionId: string }).sessionId
    const bId = (await right.json() as { sessionId: string }).sessionId
    expect(aId).not.toBe(bId)
    const listing: unknown = await (await a.raw('/employee/session/list')).json()
    expect(listing).toMatchObject({ items: [{ sessionId: aId }] })
    expect(JSON.stringify(listing)).not.toContain(bId)
    expect((await b.raw('/employee/session/page', { sessionId: aId, throughSeq: -1 })).status).toBe(404)
    expect((await a.raw('/employee/session/page', { sessionId: aId, throughSeq: -1 })).status).toBe(200)
    for (const input of [{ sessionId: bId }, { user: 'finance@example.test' }, { agentPreset: 'standard' }]) {
      expect((await a.raw('/employee/session/create', input)).status).toBe(400)
    }
    for (const path of ['/employee/session/prompt', '/employee/session/follow', '/employee/session/search', '/employee/attachment']) {
      expect((await a.raw(path)).status).toBe(404)
    }
    expect((await host.raw('session/list', { _request: {} }, a.cookie)).status).toBe(401)
    const ws = new WebSocket(host.origin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie: a.cookie } })
    const closed = new Promise<void>((resolve) => { ws.once('close', () => { resolve() }) })
    disposers.push(async () => { ws.terminate(); await closed })
    await new Promise<void>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => {
        try { expect(response.statusCode).toBe(401); resolve() } catch (error) {
          reject(new Error('employee upgrade was not denied', { cause: error }))
        }
        response.destroy()
        ws.terminate()
      })
      ws.once('open', () => { ws.terminate(); reject(new Error('employee reached global event carrier')) })
      ws.once('error', () => { /* Rejected upgrade is observed through unexpected-response. */ })
    })
    await closed
    const replay = await sharedRequest(host.origin, '/employee/sso?token=' + encodeURIComponent(ticket))
    expect(replay.status).toBe(401)
    const directory = join(host.home, 'employee-owners')
    const files = await readdir(directory)
    expect(files).toHaveLength(2)
    const owners = await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))
    expect(owners.join('')).toContain('teacher@example.test')
    expect(owners.join('')).toContain('finance@example.test')
    expect(owners.join('')).not.toContain(a.cookie.split('=')[1])

    await host.stop()
    const restarted = await startEmployee(disposers, 'shared', 'http://127.0.0.1:1', host.root,
      undefined, true, authority)
    const again = await sharedLogin(restarted.origin, authority.ticket('teacher@example.test'))
    expect(await (await again.raw('/employee/session/list')).json()).toMatchObject({ items: [{ sessionId: aId }] })
    expect((await again.raw('/employee/session/page', { sessionId: bId, throughSeq: -1 })).status).toBe(404)
    await again.raw('/employee/logout')
    expect((await again.raw('/employee/session/list')).status).toBe(401)
    const finance = await sharedLogin(restarted.origin, authority.ticket('finance@example.test'))
    await authority.disable('finance@example.test')
    expect((await finance.raw('/employee/session/list')).status).toBe(401)
  })
})
