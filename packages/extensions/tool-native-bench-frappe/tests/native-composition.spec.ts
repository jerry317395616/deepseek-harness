/** Composition and policy tests for generic Native Bench Frappe reads. */

import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as NativeFrappe from '../src/index.ts'

class StubNativeSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []

  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const output = JSON.stringify({
      ok: true,
      result: { rows: [{ name: 'STU-001', student_name: '示例学生' }], source: 'native-frappe' },
    })
    const reader = { readFrom: () => ({ text: output, nextOffset: output.length, lossy: false }) }
    const outcome: SubprocessOutcome = { exitCode: 0, signal: null }
    return {
      pid: this.specs.length,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: reader, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
      done: Promise.resolve(outcome),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('terminal is not part of this test'))
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function loadNative(): Promise<{ ctx: Context; subprocess: StubNativeSubprocess }> {
  const ctx = new CordisContext()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubNativeSubprocess)
  await ctx.plugin(NativeFrappe, {
    benchRoot: '/active/native-bench',
    site: 'child.myyr.top',
    pythonExecutable: '/active/native-bench/env/bin/python',
    frappeUser: 'Administrator',
    timeoutMs: 5_000,
  })
  return { ctx, subprocess: ctx.get('subprocess') as StubNativeSubprocess }
}

function execute(ctx: Context, call: string, name: string, arguments_: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(call),
    name,
    arguments: arguments_,
  })
}

describe('Native Bench generic Frappe composition', () => {
  it('routes structured list reads through the fixed permission-aware helper', async () => {
    const { ctx, subprocess } = await loadNative()
    const result = await execute(ctx, 'frappe-list', 'native_bench_frappe_list_documents', {
      doctype: 'Student',
      fields: ['name', 'student_name'],
      filters: { enabled: 1 },
      order_by: 'modified desc',
      limit: 5,
      start: 10,
    })
    expect(result).toMatchObject({ isError: false, value: { source: 'native-frappe' } })
    expect(subprocess.specs).toHaveLength(1)
    const spec = subprocess.specs[0]
    expect(spec?.argv).toEqual([
      '/active/native-bench/env/bin/python',
      expect.stringContaining('native_frappe_query.py'),
      '--bench-root', resolve('/active/native-bench'),
      '--site', 'child.myyr.top',
      '--user', 'Administrator',
      '--operation', 'frappe_list_documents',
      '--max-input-bytes', '256000',
      '--max-output-bytes', '1000000',
    ])
    expect(spec?.cwd).toBe(resolve('/active/native-bench'))
    expect(spec?.env).toEqual({ PYTHONPATH: resolve('/active/native-bench/apps') })
    expect(spec?.stdio.stdin).toMatchObject({
      data: JSON.stringify({ arguments: {
        doctype: 'Student',
        fields: ['name', 'student_name'],
        filters: { enabled: 1 },
        order_by: 'modified desc',
        limit: 5,
        start: 10,
      } }),
    })
  })

  it('rejects sensitive fields and SQL-shaped filters before spawning', async () => {
    const { ctx, subprocess } = await loadNative()
    const fieldResult = await execute(ctx, 'frappe-sensitive-field', 'native_bench_frappe_get_document', {
      doctype: 'Student',
      name: 'STU-001',
      fields: ['name', 'api_key'],
    })
    expect(fieldResult.isError).toBe(true)
    expect(subprocess.specs).toHaveLength(0)

    const filterResult = await execute(ctx, 'frappe-sql-filter', 'native_bench_frappe_list_documents', {
      doctype: 'Student',
      filters: [['name', 'in', ['STU-001', { sql: 'DROP TABLE' }]]],
    })
    expect(filterResult.isError).toBe(true)
    expect(subprocess.specs).toHaveLength(0)
  })
})
