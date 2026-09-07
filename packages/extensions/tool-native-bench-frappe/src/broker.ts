/** Credential-free client for the deployment-owned Linux read broker. */

import { createConnection } from 'node:net'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Validated deployment socket and complete-exchange resource limits. */
export interface EmployeeBrokerSpec {
  socketPath: string
  timeoutMs: number
  maxInputBytes: number
  maxOutputBytes: number
}

/**
 * Send one scoped read without employee identity, paths, or credentials on the wire.
 * @param spec Validated deployment path and limits.
 * @param operation Read operation accepted by the trusted broker.
 * @param arguments_ Normalized model arguments.
 * @param signal Cancellation closes and awaits this client connection, not remote work.
 * @returns The broker result; rejects with fixed diagnostics on denial or transport failure.
 */
export async function readEmployeeBroker(
  spec: EmployeeBrokerSpec,
  operation: string,
  arguments_: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!['frappe_describe_doctype', 'frappe_list_documents', 'frappe_get_document'].includes(operation)) {
    throw new Error('native-bench-frappe: broker only permits reads')
  }
  const payload = JSON.stringify({ version: 1, operation, arguments: arguments_ }) + '\n'
  if (Buffer.byteLength(payload) > spec.maxInputBytes) {
    throw new Error('native-bench-frappe: broker request exceeds the input limit')
  }
  if (signal.aborted) throw new Error('native-bench-frappe: broker request was cancelled')
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: spec.socketPath })
    const chunks: Buffer[] = []
    let size = 0
    let ended = false
    let failure: Error | undefined
    const fail = (message: string): void => {
      failure ??= new Error(message)
      socket.destroy()
    }
    const cancel = (): void => { fail('native-bench-frappe: broker request was cancelled') }
    const timer = setTimeout(() => { fail('native-bench-frappe: broker request timed out') }, spec.timeoutMs)
    timer.unref()
    signal.addEventListener('abort', cancel, { once: true })
    socket.once('connect', () => { socket.end(payload) })
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > spec.maxOutputBytes) {
        fail('native-bench-frappe: broker result exceeds the output limit')
      } else {
        chunks.push(chunk)
      }
    })
    socket.once('end', () => { ended = true })
    socket.once('error', () => { fail('native-bench-frappe: broker connection failed') })
    socket.once('close', () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      if (failure !== undefined) { reject(failure); return }
      if (!ended) { reject(new Error('native-bench-frappe: broker connection closed without a result')); return }
      let response: unknown
      try {
        response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      } catch {
        reject(new Error('native-bench-frappe: broker returned invalid JSON'))
        return
      }
      if (response === null || typeof response !== 'object' || Array.isArray(response)
        || !('ok' in response) || response.ok !== true || !('result' in response)) {
        reject(new Error('native-bench-frappe: broker rejected the operation'))
        return
      }
      // JSON.parse owns the wire conversion; the trusted broker sanitizes record fields.
      resolve(response.result as JsonValue)
    })
  })
}
