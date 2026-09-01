/** Composition and policy tests for the local Native Bench Frappe adapter. */

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
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as NutritionRules from '../src/index.ts'

class StubNativeSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []

  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const output = JSON.stringify({ ok: true, result: { source: 'native-frappe', operation: spec.argv.at(-1) } })
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
  await ctx.plugin(NutritionRules, {
    transport: 'native',
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
    callId: ToolCallId(call),
    name,
    arguments: arguments_,
  })
}

describe('Tongjianyun native Frappe composition', () => {
  it('routes read operations to the fixed helper and strips UI-only selectors', async () => {
    const { ctx, subprocess } = await loadNative()
    const result = await execute(ctx, 'native-standard', 'tongjianyun_explain_nutrition_standard', {
      metric: 'energy',
      recipe: 'ignored-by-server',
      standard_mode: '自动（按学生档案）',
      student_groups: ['CLASS-1'],
    })
    expect(result).toMatchObject({ isError: false, value: { source: 'native-frappe' } })
    expect(subprocess.specs).toHaveLength(1)
    const spec = subprocess.specs[0]
    expect(spec?.argv).toEqual([
      '/active/native-bench/env/bin/python',
      expect.stringContaining('native_query.py'),
      '--bench-root', resolve('/active/native-bench'),
      '--site', 'child.myyr.top',
      '--user', 'Administrator',
      '--operation', 'frappe_explain_tongjianyun_nutrition_standard',
    ])
    expect(spec?.stdio.stdin).toMatchObject({ data: JSON.stringify({ arguments: { metric: 'energy' } }) })
  })

  it('rejects rule writes locally before spawning a helper', async () => {
    const { ctx, subprocess } = await loadNative()
    const result = await execute(ctx, 'native-write', 'tongjianyun_publish_nutrition_rule', {
      rule_set: 'RULE-1',
      confirmation: '确认发布',
    })
    expect(result).toMatchObject({
      isError: true,
      error: { message: 'tongjianyun-nutrition-rules: native transport only supports read operations; configure transport: mcp for rule changes' },
    })
    expect(subprocess.specs).toHaveLength(0)
  })
})
