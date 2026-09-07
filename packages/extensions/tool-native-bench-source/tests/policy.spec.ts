import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Policy from '../src/policy.ts'

let ctx: Context
let calls: string[]
beforeEach(async () => {
  ctx = new Context()
  calls = []
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
})
afterEach(async () => { await ctx.fiber.dispose() })

function register(name: string) {
  ctx.tools.register(defineTool({
    name, description: 'Admission test', parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'executed' }] },
    execute: async () => { calls.push(name); return { executed: true } },
  }))
}
function execute(name: string, args: unknown = {}) {
  return ctx.tools.execute({ name, arguments: args, callId: ToolCallId('policy-test'), signal: new AbortController().signal })
}

describe('hosted Native Bench admission', () => {
  it.each(['bash', 'run_code', 'write_file', 'apply_patch', 'native_bench_deploy_tongjianyun_extension',
    'plugin_install', 'settings_write', 'spawn_agent', 'http_request', 'frappe_create_doctype',
    'tongjianyun_publish_nutrition_rule', 'future_new_tool'])(
    'denies %s before execution', async (name) => {
      if (name !== 'run_code') register(name)
      await ctx.plugin(Policy)
      const result = await execute(name)
      expect(result.isError).toBe(true)
      expect(calls).toEqual([])
    },
  )

  it('does not let an unconditional policy approval bypass the monotonic guard', async () => {
    register('bash')
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    await ctx.plugin(Policy)
    expect((await execute('bash')).isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('keeps existing operations subject to their own checks without adding an approval', async () => {
    for (const name of ['native_bench_frappe_get_document', 'tongjianyun_get_weekly_nutrition_analysis',
      'frappe_docs_search', 'native_bench_frappe_apply_document_update']) register(name)
    await ctx.plugin(Policy)
    for (const name of ['native_bench_frappe_get_document', 'tongjianyun_get_weekly_nutrition_analysis', 'frappe_docs_search']) {
      expect((await execute(name)).isError).toBe(false)
    }
    ctx.on('tools/pre-execute', async execution => execution.name.endsWith('apply_document_update')
      ? { kind: 'deny', reason: 'existing business permission denied' } : { kind: 'allow' })
    expect((await execute('native_bench_frappe_apply_document_update')).isError).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it.each([null, [], '', {}, { change_kind: null }, { change_kind: 'add-field' },
    { change_kind: 'modify-field' }, { change_kind: 'business-logic' }, { change_kind: 'new-doctype' }])(
    'rejects structural or malformed extension planning %j', async (args) => {
      register('native_bench_plan_tongjianyun_extension')
      await ctx.plugin(Policy)
      expect((await execute('native_bench_plan_tongjianyun_extension', args)).isError).toBe(true)
      expect(calls).toEqual([])
    },
  )

  it.each(['form-ui', 'list-ui', 'desk-page', 'custom-page', 'report', 'workspace'])(
    'permits read-only planning for %s', async (change_kind) => {
      register('native_bench_plan_tongjianyun_extension')
      await ctx.plugin(Policy)
      expect((await execute('native_bench_plan_tongjianyun_extension', { change_kind })).isError).toBe(false)
      expect(calls).toHaveLength(1)
    },
  )

  it('removes both restrictions and the prompt on trusted plugin disposal', async () => {
    register('bash')
    const fiber = ctx.plugin(Policy)
    await fiber
    expect((await execute('bash')).isError).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'native-bench:business-policy')).toBe(true)
    await fiber.dispose()
    expect((await execute('bash')).isError).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'native-bench:business-policy')).toBe(false)
  })
})
