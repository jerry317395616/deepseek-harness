/** Native Frappe transport for the read-only Tongjianyun nutrition tools. */

import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** Operations that may run inside a local Frappe request context. */
export const NATIVE_READ_OPERATIONS = new Set([
  'frappe_explain_tongjianyun_nutrition_standard',
  'frappe_get_tongjianyun_weekly_nutrition_analysis',
  'frappe_list_tongjianyun_nutrition_rules',
])

/** Fixed, deployment-owned native Frappe process configuration. */
export interface NutritionNativeSpec {
  benchRoot: string
  site: string
  pythonExecutable: string
  helperPath: string
  frappeUser: string
  maxOutputBytes: number
  graceMs: number
}

/** Resolve and validate the local Native Bench settings without reading secrets. */
export function resolveNutritionNativeSpec(config: {
  benchRoot?: string
  site?: string
  pythonExecutable?: string
  frappeUser?: string
  maxOutputBytes?: number
}): NutritionNativeSpec {
  const benchRootInput = config.benchRoot?.trim() || '/home/zyd/frappe/native-bench'
  if (!isAbsolute(benchRootInput)) {
    throw new Error('tongjianyun-nutrition-rules: benchRoot must be an absolute path')
  }
  const benchRoot = resolve(benchRootInput)
  const site = config.site?.trim() || 'child.myyr.top'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(site)) {
    throw new Error('tongjianyun-nutrition-rules: site must be a simple Frappe site name')
  }
  const executableInput = config.pythonExecutable?.trim()
  const pythonExecutable = executableInput === undefined || executableInput === ''
    ? join(benchRoot, 'env', 'bin', 'python')
    : isAbsolute(executableInput) ? executableInput : resolve(benchRoot, executableInput)
  const frappeUser = config.frappeUser?.trim() || 'Administrator'
  if (frappeUser === '' || frappeUser.length > 254 || /[\r\n]/u.test(frappeUser)) {
    throw new Error('tongjianyun-nutrition-rules: frappeUser must be a single account name')
  }
  const maxOutputBytes = config.maxOutputBytes ?? 1_000_000
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 16_384 || maxOutputBytes > 5_000_000) {
    throw new Error('tongjianyun-nutrition-rules: maxOutputBytes must be an integer from 16384 to 5000000')
  }
  return {
    benchRoot,
    site,
    pythonExecutable,
    helperPath: fileURLToPath(new URL('../python/native_query.py', import.meta.url)),
    frappeUser,
    maxOutputBytes,
    graceMs: 2_000,
  }
}

/** Run the allowlisted Frappe business functions in the active Bench process. */
export class NutritionNativeClient {
  constructor(
    private readonly ctx: Context,
    private readonly spec: NutritionNativeSpec,
  ) {}

  /**
   * Execute one bounded, read-only Frappe operation without a network hop.
   * The helper imports the Tongjianyun MCP business functions after Frappe has
   * initialized the configured site, so the same ORM permissions and formula
   * code are used as the web application.
   */
  async call(
    operation: string,
    arguments_: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (!NATIVE_READ_OPERATIONS.has(operation)) {
      throw new Error(
        'tongjianyun-nutrition-rules: native transport is read-only; configure MCP for rule changes',
      )
    }
    if (signal.aborted) throw new Error('tongjianyun-nutrition-rules: native Frappe request was cancelled')
    const payload = JSON.stringify({ arguments: nativeArguments(operation, arguments_) })
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
      throw new Error('tongjianyun-nutrition-rules: native Frappe process could not start', { cause: error })
    }

    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error('tongjianyun-nutrition-rules: native Frappe process failed', { cause: error })
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    if (stdout === undefined) throw new Error('tongjianyun-nutrition-rules: native Frappe produced no output')
    if (stdout.lossy) throw new Error('tongjianyun-nutrition-rules: native Frappe result exceeded its output limit')
    if (outcome.signal !== null || outcome.exitCode === null) {
      throw new Error('tongjianyun-nutrition-rules: native Frappe process was terminated')
    }
    if (outcome.exitCode !== 0) {
      const stderr = handle.collected.stderr?.readFrom(0).text.trim()
      throw new Error(
        `tongjianyun-nutrition-rules: native Frappe request failed${stderr ? `: ${redactDiagnostic(stderr)}` : ''}`,
      )
    }
    let response: unknown
    try {
      response = JSON.parse(stdout.text)
    } catch (error) {
      throw new Error('tongjianyun-nutrition-rules: native Frappe returned invalid JSON', { cause: error })
    }
    if (!isRecord(response) || response.ok !== true || !('result' in response)) {
      const message = isRecord(response) && typeof response.error === 'string' ? response.error : 'unknown error'
      throw new Error(`tongjianyun-nutrition-rules: native Frappe rejected the operation: ${redactDiagnostic(message)}`)
    }
    return response.result as JsonValue
  }
}

/** Strip model-only fields that are not part of the Frappe function signature. */
function nativeArguments(operation: string, arguments_: Record<string, JsonValue>): Record<string, JsonValue> {
  const result = { ...arguments_ }
  if (operation === 'frappe_explain_tongjianyun_nutrition_standard') {
    delete result.recipe
    delete result.standard_mode
    delete result.student_groups
  }
  if (operation === 'frappe_get_tongjianyun_weekly_nutrition_analysis') {
    delete result.standard_mode
    delete result.student_groups
  }
  return result
}

/** Keep helper diagnostics bounded and avoid echoing credential-shaped values. */
function redactDiagnostic(value: string): string {
  return value
    .replace(/(password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .slice(0, 500)
}

/** Type guard for JSON objects returned over the process boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
