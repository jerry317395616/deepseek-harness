/** Local transport for bounded reads from the synchronized Frappe documentation index. */

import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** Operations available to model-facing documentation tools. */
export const FRAPPE_DOCS_OPERATIONS = new Set([
  'search',
  'get_page',
  'status',
])

/** Fixed, deployment-owned documentation index process configuration. */
export interface FrappeDocsSpec {
  knowledgeRoot: string
  pythonExecutable: string
  helperPath: string
  maxOutputBytes: number
  maxInputBytes: number
  graceMs: number
}

/**
 * Resolve local knowledge-base settings without accepting paths from the model.
 * @param config Deployment-owned paths and subprocess byte limits.
 * @returns Validated settings for the packaged documentation helper.
 */
export function resolveFrappeDocsSpec(config: {
  knowledgeRoot?: string
  pythonExecutable?: string
  maxOutputBytes?: number
  maxInputBytes?: number
}): FrappeDocsSpec {
  const rootInput = config.knowledgeRoot?.trim() || '/home/zyd/frappe/frappe-docs-kb'
  if (!isAbsolute(rootInput)) throw new Error('frappe-docs: knowledgeRoot must be an absolute path')
  const executableInput = config.pythonExecutable?.trim() || '/usr/bin/python3'
  if (!isAbsolute(executableInput)) throw new Error('frappe-docs: pythonExecutable must be an absolute path')
  const maxOutputBytes = config.maxOutputBytes ?? 1_000_000
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 16_384 || maxOutputBytes > 5_000_000) {
    throw new Error('frappe-docs: maxOutputBytes must be an integer from 16384 to 5000000')
  }
  const maxInputBytes = config.maxInputBytes ?? 64_000
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 4_096 || maxInputBytes > 256_000) {
    throw new Error('frappe-docs: maxInputBytes must be an integer from 4096 to 256000')
  }
  return {
    knowledgeRoot: resolve(rootInput),
    pythonExecutable: resolve(executableInput),
    helperPath: fileURLToPath(new URL('../python/frappe_docs_kb.py', import.meta.url)),
    maxOutputBytes,
    maxInputBytes,
    graceMs: 2_000,
  }
}

/** Execute one read-only operation against the local documentation index. */
export class FrappeDocsClient {
  constructor(
    private readonly ctx: Context,
    private readonly spec: FrappeDocsSpec,
  ) {}

  /**
   * Run a validated helper operation and return its canonical JSON result.
   * @param operation Allowlisted documentation-index operation.
   * @param arguments_ Bounded, model-supplied operation arguments.
   * @param signal Cancellation signal for the subprocess operation.
   * @returns Canonical JSON emitted by the local helper.
   */
  async call(
    operation: string,
    arguments_: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (!FRAPPE_DOCS_OPERATIONS.has(operation)) {
      throw new Error('frappe-docs: only allowlisted read operations are available')
    }
    if (signal.aborted) throw new Error('frappe-docs: request was cancelled')
    const payload = JSON.stringify({ arguments: normalizeArguments(operation, arguments_) })
    if (Buffer.byteLength(payload, 'utf8') > this.spec.maxInputBytes) {
      throw new Error('frappe-docs: request arguments exceed the configured input limit')
    }
    let handle: SubprocessHandle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [
          this.spec.pythonExecutable,
          this.spec.helperPath,
          '--knowledge-root', this.spec.knowledgeRoot,
          '--operation', operation,
          '--max-input-bytes', String(this.spec.maxInputBytes),
          '--max-output-bytes', String(this.spec.maxOutputBytes),
        ],
        cwd: this.spec.knowledgeRoot,
        stdio: {
          stdin: { data: payload },
          stdout: { maxBytes: this.spec.maxOutputBytes },
          stderr: { maxBytes: 16_000 },
        },
        graceMs: this.spec.graceMs,
        signal,
      } satisfies SubprocessSpawnSpec)
    } catch (error) {
      throw new Error('frappe-docs: documentation process could not start', { cause: error })
    }

    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error('frappe-docs: documentation process failed', { cause: error })
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    if (stdout === undefined) throw new Error('frappe-docs: helper produced no output')
    if (stdout.lossy) throw new Error('frappe-docs: result exceeded its output limit')
    if (outcome.signal !== null || outcome.exitCode === null) {
      throw new Error('frappe-docs: helper was terminated')
    }
    if (outcome.exitCode !== 0) {
      const stderr = handle.collected.stderr?.readFrom(0).text.trim()
      throw new Error(`frappe-docs: request failed${stderr ? `: ${redactDiagnostic(stderr)}` : ''}`)
    }
    let response: unknown
    try {
      response = JSON.parse(stdout.text)
    } catch (error) {
      throw new Error('frappe-docs: helper returned invalid JSON', { cause: error })
    }
    if (!isRecord(response) || response.ok !== true || !('result' in response)) {
      const message = isRecord(response) && typeof response.error === 'string' ? response.error : 'unknown error'
      throw new Error(`frappe-docs: helper rejected the operation: ${redactDiagnostic(message)}`)
    }
    return response.result
  }
}

/** Validate model arguments before they cross the subprocess boundary. */
function normalizeArguments(operation: string, arguments_: Record<string, JsonValue>): Record<string, JsonValue> {
  const result = { ...arguments_ }
  if (operation === 'status') {
    if (Object.keys(result).length !== 0) throw new Error('frappe-docs: status does not accept arguments')
    return result
  }
  if (operation === 'search') {
    const query = singleLine(result.query, 'query', 500)
    if (query.trim() === '') throw new Error('frappe-docs: query must not be empty')
    result.query = query.trim()
    for (const field of ['product', 'version', 'language'] as const) {
      const value = result[field]
      if (value === undefined) continue
      const normalized = singleLine(value, field, 80).trim()
      if (normalized === '' || !/^[\p{L}\p{N}_. -]+$/u.test(normalized)) {
        throw new Error(`frappe-docs: ${field} contains unsupported characters`)
      }
      result[field] = normalized
    }
    const limit = result.limit
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20)) {
      throw new Error('frappe-docs: limit must be an integer from 1 to 20')
    }
    return result
  }
  const page = singleLine(result.page, 'page', 1_000).trim()
  if (page === '') throw new Error('frappe-docs: page must not be empty')
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(page) && !page.startsWith('https://docs.frappe.io/')) {
    throw new Error('frappe-docs: page URL must use the official docs.frappe.io origin')
  }
  result.page = page
  const heading = result.heading
  if (heading !== undefined) result.heading = singleLine(heading, 'heading', 300).trim()
  const maxCharacters = result.max_characters
  if (maxCharacters !== undefined && (
    typeof maxCharacters !== 'number'
    || !Number.isInteger(maxCharacters)
    || maxCharacters < 1_000
    || maxCharacters > 50_000
  )) {
    throw new Error('frappe-docs: max_characters must be an integer from 1000 to 50000')
  }
  return result
}

function singleLine(value: JsonValue | undefined, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength || /[\r\n\0]/u.test(value)) {
    throw new Error(`frappe-docs: ${field} must be one string of at most ${maxLength} characters`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(?:password|secret|token|api[-_]?key)\s*[=:]\s*\S+/giu, '$1=[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 1_000)
}
