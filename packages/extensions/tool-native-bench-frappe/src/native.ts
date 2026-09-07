/** Native Frappe transport for bounded Bench discovery, reads, and approved updates. */

import { readEmployeeBroker } from './broker.ts'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** Operations exposed by the local Frappe helper. */
export const NATIVE_FRAPPE_OPERATIONS = new Set([
  'frappe_platform_catalog',
  'frappe_describe_doctype',
  'frappe_list_documents',
  'frappe_get_document',
  'frappe_preview_document_update',
  'frappe_apply_document_update',
])

/** Fixed, deployment-owned native Frappe process configuration. */
export interface NativeFrappeSpec {
  benchRoot: string
  site: string
  pythonExecutable: string
  helperPath: string
  frappeUser: string
  accessMode: 'maintenance' | 'business'
  actorTokenFile: string
  brokerSocketPath: string
  timeoutMs: number
  businessDoctypes: string[]
  maxOutputBytes: number
  maxInputBytes: number
  graceMs: number
}

/**
 * Resolve and validate local Native Bench settings without reading secrets.
 * @param config Deployment-owned Bench, site, identity, and subprocess limits.
 * @returns Validated settings for the packaged native Frappe helper.
 */
export function resolveNativeFrappeSpec(config: {
  benchRoot?: string
  site?: string
  pythonExecutable?: string
  frappeUser?: string
  accessMode?: string
  actorTokenFile?: string
  brokerSocketPath?: string
  timeoutMs?: number
  businessDoctypes?: string[]
  maxOutputBytes?: number
  maxInputBytes?: number
}): NativeFrappeSpec {
  const benchRootInput = config.benchRoot?.trim() || '/home/zyd/frappe/native-bench'
  if (!isAbsolute(benchRootInput)) {
    throw new Error('native-bench-frappe: benchRoot must be an absolute path')
  }
  const benchRoot = resolve(benchRootInput)
  const site = config.site?.trim() || 'child.myyr.top'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(site)) {
    throw new Error('native-bench-frappe: site must be a simple Frappe site name')
  }
  const executableInput = config.pythonExecutable?.trim()
  const pythonExecutable = executableInput === undefined || executableInput === ''
    ? join(benchRoot, 'env', 'bin', 'python')
    : isAbsolute(executableInput) ? executableInput : resolve(benchRoot, executableInput)
  const brokerSocketPath = config.brokerSocketPath?.trim() ?? ''
  if (brokerSocketPath !== '' && (process.platform !== 'linux' || !isAbsolute(brokerSocketPath)
    || Buffer.byteLength(brokerSocketPath) > 107 || /[\u0000\r\n]/u.test(brokerSocketPath))) {
    throw new Error('native-bench-frappe: broker requires a Linux absolute Unix socket path')
  }
  const frappeUser = config.frappeUser?.trim() || (brokerSocketPath === '' ? 'Administrator' : '')
  if ((frappeUser === '' && brokerSocketPath === '') || frappeUser.length > 254 || /[\r\n]/u.test(frappeUser)) {
    throw new Error('native-bench-frappe: frappeUser must be a single account name')
  }
  const accessMode = config.accessMode ?? 'maintenance'
  if (accessMode !== 'maintenance' && accessMode !== 'business') {
    throw new Error('native-bench-frappe: accessMode must be maintenance or business')
  }
  const actorTokenFile = config.actorTokenFile?.trim() ?? ''
  const businessDoctypes = [...new Set(config.businessDoctypes ?? [])]
  if (brokerSocketPath !== '' && (accessMode !== 'business' || actorTokenFile !== '' || frappeUser !== '')) {
    throw new Error('native-bench-frappe: broker requires business mode without caller identity or assertion files')
  }
  if (accessMode === 'business') {
    if (brokerSocketPath === '' && (!config.frappeUser?.trim() || frappeUser === 'Guest')) {
      throw new Error('native-bench-frappe: business mode requires an explicit expected Frappe user')
    }
    if (brokerSocketPath === '' && (!isAbsolute(actorTokenFile) || /[\u0000\r\n]/u.test(actorTokenFile))) {
      throw new Error('native-bench-frappe: business mode requires an absolute private actor token file')
    }
    if (businessDoctypes.length === 0 || businessDoctypes.length > 64
      || businessDoctypes.some(doctype => !doctype.trim() || doctype !== doctype.trim()
        || doctype.length > 140 || /[\u0000\r\n]/u.test(doctype))) {
      throw new Error('native-bench-frappe: business mode requires 1 to 64 explicit DocTypes')
    }
  } else if (actorTokenFile !== '' || businessDoctypes.length > 0) {
    throw new Error('native-bench-frappe: actor credentials and business scope require business mode')
  }
  const maxOutputBytes = config.maxOutputBytes ?? 1_000_000
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 16_384 || maxOutputBytes > 5_000_000) {
    throw new Error('native-bench-frappe: maxOutputBytes must be an integer from 16384 to 5000000')
  }
  const maxInputBytes = config.maxInputBytes ?? 256_000
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 16_384 || maxInputBytes > 1_000_000) {
    throw new Error('native-bench-frappe: maxInputBytes must be an integer from 16384 to 1000000')
  }
  const timeoutMs = config.timeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error('native-bench-frappe: timeoutMs must be an integer from 1000 to 120000')
  }
  return {
    benchRoot,
    site,
    pythonExecutable,
    helperPath: fileURLToPath(new URL('../python/native_frappe_query.py', import.meta.url)),
    frappeUser,
    accessMode,
    actorTokenFile,
    brokerSocketPath,
    timeoutMs,
    businessDoctypes,
    maxOutputBytes,
    maxInputBytes,
    graceMs: 2_000,
  }
}

/** Run one allowlisted Frappe operation in the active Bench process. */
export class NativeFrappeClient {
  constructor(
    private readonly ctx: Context,
    private readonly spec: NativeFrappeSpec,
  ) {}

  /**
   * Execute a bounded local read or approved update; broker mode never spawns Bench.
   * @param operation Allowlisted native Frappe operation.
   * @param arguments_ Bounded, model-supplied operation arguments.
   * @param signal Cancellation signal for the process or local-socket exchange.
   * @returns Canonical JSON emitted by the configured helper or broker.
   */
  async call(
    operation: string,
    arguments_: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (!NATIVE_FRAPPE_OPERATIONS.has(operation)) {
      throw new Error('native-bench-frappe: only allowlisted Frappe operations are available')
    }
    if (this.spec.accessMode === 'business') {
      if (!['frappe_describe_doctype', 'frappe_list_documents', 'frappe_get_document'].includes(operation)) {
        throw new Error('native-bench-frappe: business mode only permits scoped reads')
      }
      if (typeof arguments_.doctype !== 'string' || !this.spec.businessDoctypes.includes(arguments_.doctype)) {
        throw new Error('native-bench-frappe: DocType is outside the configured business scope')
      }
    }
    if (signal.aborted) throw new Error('native-bench-frappe: Frappe request was cancelled')
    const normalized = normalizeArguments(operation, arguments_)
    if (this.spec.brokerSocketPath !== '') {
      return readEmployeeBroker({
        socketPath: this.spec.brokerSocketPath,
        timeoutMs: this.spec.timeoutMs,
        maxInputBytes: this.spec.maxInputBytes,
        maxOutputBytes: this.spec.maxOutputBytes,
      }, operation, normalized, signal)
    }
    const payload = JSON.stringify({ arguments: normalized })
    if (Buffer.byteLength(payload, 'utf8') > this.spec.maxInputBytes) {
      throw new Error('native-bench-frappe: request arguments exceed the configured input limit')
    }
    let handle: SubprocessHandle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [
          this.spec.pythonExecutable,
          this.spec.helperPath,
          '--bench-root', this.spec.benchRoot,
          '--site', this.spec.site,
          '--user', this.spec.frappeUser,
          '--operation', operation,
          ...(this.spec.accessMode === 'business' ? [
            '--access-mode', 'business',
            '--actor-token-file', this.spec.actorTokenFile,
            '--business-doctypes', JSON.stringify(this.spec.businessDoctypes),
          ] : []),
          '--max-input-bytes', String(this.spec.maxInputBytes),
          '--max-output-bytes', String(this.spec.maxOutputBytes),
        ],
        cwd: this.spec.benchRoot,
        stdio: {
          stdin: { data: payload },
          stdout: { maxBytes: this.spec.maxOutputBytes },
          stderr: { maxBytes: 16_000 },
        },
        graceMs: this.spec.graceMs,
        signal,
        env: { PYTHONPATH: join(this.spec.benchRoot, 'apps') },
      } satisfies SubprocessSpawnSpec)
    } catch (error) {
      throw new Error('native-bench-frappe: Frappe process could not start', { cause: error })
    }

    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error('native-bench-frappe: Frappe process failed', { cause: error })
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    if (stdout === undefined) throw new Error('native-bench-frappe: Frappe produced no output')
    if (stdout.lossy) throw new Error('native-bench-frappe: Frappe result exceeded its output limit')
    if (outcome.signal !== null || outcome.exitCode === null) {
      throw new Error('native-bench-frappe: Frappe process was terminated')
    }
    if (outcome.exitCode !== 0) {
      const stderr = handle.collected.stderr?.readFrom(0).text.trim()
      throw new Error(
        `native-bench-frappe: Frappe request failed${stderr ? `: ${redactDiagnostic(stderr)}` : ''}`,
      )
    }
    let response: unknown
    try {
      response = JSON.parse(stdout.text)
    } catch (error) {
      throw new Error('native-bench-frappe: Frappe returned invalid JSON', { cause: error })
    }
    if (!isRecord(response) || response.ok !== true || !('result' in response)) {
      const message = isRecord(response) && typeof response.error === 'string' ? response.error : 'unknown error'
      throw new Error(`native-bench-frappe: Frappe rejected the operation: ${redactDiagnostic(message)}`)
    }
    return response.result
  }
}

/** Validate the small model-facing envelope before sending it to Python. */
function normalizeArguments(operation: string, arguments_: Record<string, JsonValue>): Record<string, JsonValue> {
  const result = { ...arguments_ }
  if (operation === 'frappe_platform_catalog') {
    const keyword = result.keyword
    if (keyword !== undefined && (typeof keyword !== 'string' || keyword.length > 140 || /[\r\n]/u.test(keyword))) {
      throw new Error('native-bench-frappe: keyword must be a single string of at most 140 characters')
    }
    const limit = result.limit
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000)) {
      throw new Error('native-bench-frappe: catalog limit must be an integer from 1 to 1000')
    }
    if (typeof keyword === 'string') result.keyword = keyword.trim()
    return result
  }
  const doctype = result.doctype
  if (typeof doctype !== 'string' || doctype.trim() === '' || doctype.length > 140 || /[\r\n]/u.test(doctype)) {
    throw new Error('native-bench-frappe: doctype must be a single non-empty name')
  }
  if (operation === 'frappe_get_document' || operation === 'frappe_preview_document_update' || operation === 'frappe_apply_document_update') {
    const name = result.name
    if (typeof name !== 'string' || name.trim() === '' || name.length > 140 || /[\r\n]/u.test(name)) {
      throw new Error('native-bench-frappe: document name must be a single non-empty name')
    }
  }
  if (operation === 'frappe_describe_doctype') {
    result.doctype = doctype.trim()
    return result
  }
  if (operation === 'frappe_preview_document_update' || operation === 'frappe_apply_document_update') {
    validateChanges(result.changes)
    if (operation === 'frappe_apply_document_update') {
      const previewId = result.preview_id
      if (typeof previewId !== 'string' || !/^[a-f0-9]{64}$/u.test(previewId)) {
        throw new Error('native-bench-frappe: preview_id must be the 64-character id returned by preview')
      }
    }
    result.doctype = doctype.trim()
    result.name = (result.name as string).trim()
    return result
  }
  if (result.fields !== undefined) validateFields(result.fields)
  if (result.filters !== undefined) validateFilters(result.filters)
  const limit = result.limit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error('native-bench-frappe: limit must be an integer from 1 to 100')
  }
  const start = result.start
  if (start !== undefined && (typeof start !== 'number' || !Number.isInteger(start) || start < 0 || start > 100_000)) {
    throw new Error('native-bench-frappe: start must be an integer from 0 to 100000')
  }
  if (result.order_by !== undefined && (typeof result.order_by !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\s+(?:asc|desc))?$/u.test(result.order_by))) {
    throw new Error('native-bench-frappe: order_by contains an unsupported expression')
  }
  result.doctype = doctype.trim()
  if (operation === 'frappe_get_document') result.name = (result.name as string).trim()
  if (typeof result.order_by === 'string') result.order_by = result.order_by.trim()
  return result
}

function validateChanges(value: JsonValue | undefined): void {
  if (!isRecord(value)) throw new Error('native-bench-frappe: changes must be an object')
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 32) {
    throw new Error('native-bench-frappe: changes must contain 1 to 32 fields')
  }
  for (const [field, fieldValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(field) || isSensitive(field) || IMMUTABLE_FIELDS.has(field)) {
      throw new Error('native-bench-frappe: changes contain an unsupported, immutable, or sensitive field')
    }
    if (Array.isArray(fieldValue) || isRecord(fieldValue)) {
      throw new Error('native-bench-frappe: changes accept scalar values only')
    }
    if (typeof fieldValue === 'string' && fieldValue.length > 20_000) {
      throw new Error('native-bench-frappe: a changed string exceeds the 20000-character limit')
    }
  }
}

const IMMUTABLE_FIELDS = new Set([
  'name', 'owner', 'creation', 'modified', 'modified_by', 'docstatus', 'idx',
  'parent', 'parentfield', 'parenttype', 'doctype',
])

function validateFields(value: JsonValue): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error('native-bench-frappe: fields must be a non-empty array of at most 64 names')
  for (const field of value) {
    if (typeof field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(field) || isSensitive(field)) {
      throw new Error('native-bench-frappe: fields contain an unsupported or sensitive name')
    }
  }
}

function validateFilters(value: JsonValue): void {
  if (Array.isArray(value)) {
    if (value.length > 32) throw new Error('native-bench-frappe: filters contain too many conditions')
    for (const condition of value) {
      if (!Array.isArray(condition) || condition.length !== 3) {
        throw new Error('native-bench-frappe: filters contain an unsupported condition')
      }
      const [field, operator, filterValue] = condition
      if (typeof field !== 'string' || typeof operator !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(field) || !['=', '!=', '>', '<', '>=', '<=', 'like', 'in', 'not in', 'between', 'is'].includes(operator)) {
        throw new Error('native-bench-frappe: filters contain an unsupported condition')
      }
      if (filterValue === undefined) throw new Error('native-bench-frappe: filters contain an unsupported condition')
      validateFilterValue(filterValue)
    }
    return
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length > 32) throw new Error('native-bench-frappe: filters contain too many fields')
    for (const [field, filter] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(field)) throw new Error('native-bench-frappe: filters contain an unsupported field')
      validateFilterValue(filter)
    }
    return
  }
  throw new Error('native-bench-frappe: filters must be an object or condition array')
}

function validateFilterValue(value: JsonValue): void {
  if (Array.isArray(value)) {
    if (value.length > 100 || value.some(item => isRecord(item) || Array.isArray(item))) throw new Error('native-bench-frappe: filter values are too complex')
    return
  }
  if (isRecord(value)) throw new Error('native-bench-frappe: filter values must be JSON scalars or scalar arrays')
}

function isSensitive(value: string): boolean {
  return /(password|secret|token|api[_-]?key|api[_-]?secret|credential|authorization|private[_-]?key)/iu.test(value)
}

function redactDiagnostic(value: string): string {
  return value.replace(/(password|secret|token|api[_-]?key|credential|authorization)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]').slice(0, 500)
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
