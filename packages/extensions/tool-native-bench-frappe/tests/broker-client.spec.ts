/** Local-socket client behavior with no Bench, subprocess provider, or credentials. */

import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEventListeners } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { readEmployeeBroker } from '../src/broker.ts'
import type { EmployeeBrokerSpec } from '../src/broker.ts'
import { NativeFrappeClient, resolveNativeFrappeSpec } from '../src/native.ts'
import { Config } from '../src/index.ts'

let root: string | undefined
let server: Server | undefined
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  if (server !== undefined) {
    const owned = server
    await new Promise<void>((resolve, reject) => {
      owned.close((error) => { if (error) reject(error); else resolve() })
    })
  }
  server = undefined
  sockets.clear()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function endpoint(respond: (socket: Socket, request: string) => void): Promise<EmployeeBrokerSpec> {
  root = await mkdtemp(join(tmpdir(), 'dsh-bc-'))
  const socketPath = join(root, 'read.sock')
  server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    socket.on('error', () => { /* Test-owned peer resets are expected during cancellation. */ })
    let request = ''
    socket.on('data', (data: Buffer) => { request += data.toString('utf8') })
    socket.once('end', () => { respond(socket, request) })
  })
  const owned = server
  await new Promise<void>((resolve, reject) => {
    owned.once('error', reject)
    owned.listen(socketPath, resolve)
  })
  return { socketPath, timeoutMs: 1000, maxInputBytes: 16384, maxOutputBytes: 16384 }
}

describe.skipIf(process.platform !== 'linux')('employee read broker client', () => {
  it('uses only the scoped socket request and never invokes Bench', async () => {
    const requests: unknown[] = []
    const spec = await endpoint((socket, request) => {
      requests.push(JSON.parse(request))
      socket.end(JSON.stringify({ ok: true, result: { rows: [{ name: 'fixture-student' }] } }) + '\n')
    })
    const resolved = resolveNativeFrappeSpec(Config({
      accessMode: 'business', brokerSocketPath: spec.socketPath,
      businessDoctypes: ['Student'], timeoutMs: 1000,
    }))
    expect(resolved.frappeUser).toBe('')
    expect(resolved.actorTokenFile).toBe('')
    // No provider exists: a fallback to the direct Bench client fails this test.
    const client = new NativeFrappeClient({} as Context, resolved)
    const signal = new AbortController().signal
    await expect(client.call('frappe_list_documents', { doctype: 'Student' }, signal))
      .resolves.toEqual({ rows: [{ name: 'fixture-student' }] })
    expect(requests).toEqual([{ version: 1, operation: 'frappe_list_documents', arguments: { doctype: 'Student' } }])
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  it('rejects mixed identity, maintenance, invalid paths and deadlines', () => {
    const base = { accessMode: 'business', brokerSocketPath: '/run/ione/read.sock', businessDoctypes: ['Student'] }
    for (const config of [
      { ...base, frappeUser: 'Administrator' }, { ...base, actorTokenFile: '/private/identity' },
      { ...base, accessMode: 'maintenance' },
    ]) expect(() => resolveNativeFrappeSpec(config)).toThrow('broker requires business mode')
    for (const path of ['relative', '/run/' + 'x'.repeat(108), '/run/invalid\n']) {
      expect(() => resolveNativeFrappeSpec({ ...base, brokerSocketPath: path + 'x' })).toThrow('Unix socket path')
    }
    expect(() => resolveNativeFrappeSpec({ ...base, timeoutMs: 0 })).toThrow('timeoutMs')
    expect(() => resolveNativeFrappeSpec({ ...base, businessDoctypes: [] })).toThrow('explicit DocTypes')
  })

  it('retains direct-call operation and DocType checks before connecting', async () => {
    const client = new NativeFrappeClient({} as Context, resolveNativeFrappeSpec({
      accessMode: 'business', brokerSocketPath: '/nonexistent/read.sock', businessDoctypes: ['Student'],
    }))
    await expect(client.call('frappe_get_document', { doctype: 'User', name: 'Administrator' }, new AbortController().signal))
      .rejects.toThrow('outside the configured business scope')
    await expect(client.call('frappe_apply_document_update', { doctype: 'Student' }, new AbortController().signal))
      .rejects.toThrow('only permits scoped reads')
  })

  it('preserves the complete UTF-8 result within the limit', async () => {
    const result = { value: '学生'.repeat(2000) }
    const spec = await endpoint((socket) => { socket.end(JSON.stringify({ ok: true, result }) + '\n') })
    await expect(readEmployeeBroker(spec, 'frappe_get_document', { doctype: 'Student', name: 'fixture' }, new AbortController().signal))
      .resolves.toEqual(result)
  })

  it('rejects oversized complete envelopes without forwarding their body', async () => {
    const spec = await endpoint((socket) => { socket.end(JSON.stringify({ ok: true, result: 'x'.repeat(20000) })) })
    await expect(readEmployeeBroker(spec, 'frappe_list_documents', { doctype: 'Student' }, new AbortController().signal))
      .rejects.toThrow('output limit')
  })

  it.each([
    '{"ok":false,"error":"PRIVATE_DIAGNOSTIC"}\n', '{"ok":true}\n', '[]\n', '{broken',
  ])('returns a fixed rejection for invalid response %s', async (response) => {
    const spec = await endpoint((socket) => { socket.end(response) })
    await expect(readEmployeeBroker(spec, 'frappe_list_documents', { doctype: 'Student' }, new AbortController().signal))
      .rejects.toThrow(/broker (rejected the operation|returned invalid JSON)/u)
  })

  it('rejects invalid UTF-8 instead of replacing bytes', async () => {
    const spec = await endpoint((socket) => { socket.end(Buffer.from([0xff])) })
    await expect(readEmployeeBroker(spec, 'frappe_list_documents', { doctype: 'Student' }, new AbortController().signal))
      .rejects.toThrow('invalid JSON')
  })

  it('fails closed when the socket is absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-bc-'))
    const spec = { socketPath: join(root, 'absent'), timeoutMs: 1000, maxInputBytes: 16384, maxOutputBytes: 16384 }
    await expect(readEmployeeBroker(spec, 'frappe_list_documents', { doctype: 'Student' }, new AbortController().signal))
      .rejects.toThrow('connection failed')
  })

  it('bounds a stalled exchange and removes its abort listener', async () => {
    const spec = await endpoint(() => {})
    const signal = new AbortController().signal
    await expect(readEmployeeBroker({ ...spec, timeoutMs: 50 }, 'frappe_list_documents', { doctype: 'Student' }, signal))
      .rejects.toThrow('timed out')
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  it('cancels after admission and awaits connection teardown', async () => {
    const controller = new AbortController()
    const spec = await endpoint(() => { controller.abort() })
    await expect(readEmployeeBroker(spec, 'frappe_list_documents', { doctype: 'Student' }, controller.signal))
      .rejects.toThrow('cancelled')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('rejects pre-cancellation, writes and oversized requests before connecting', async () => {
    const spec = { socketPath: '/nonexistent/read.sock', timeoutMs: 1000, maxInputBytes: 16384, maxOutputBytes: 16384 }
    const controller = new AbortController()
    controller.abort()
    await expect(readEmployeeBroker(spec, 'frappe_list_documents', {}, controller.signal)).rejects.toThrow('cancelled')
    await expect(readEmployeeBroker(spec, 'shell', {}, new AbortController().signal)).rejects.toThrow('only permits reads')
    await expect(readEmployeeBroker(spec, 'frappe_list_documents', { data: 'x'.repeat(16384) }, new AbortController().signal))
      .rejects.toThrow('input limit')
  })
})
