/**
 * Real-composition guard for the Tongjianyun nutrition-rule tools: a Loader
 * boots the actual tool and credential plugins from cordis.yml, then a local
 * Frappe-MCP stand-in receives the authenticated JSON-RPC calls.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NutritionRules from '../src/index.ts'

interface FrappeRequest {
  authorization: string | undefined
  body: {
    id: number
    method: string
    params: {
      name: string
      arguments: Record<string, unknown>
    }
  }
}

let root: string | undefined
let context: Context | undefined
let server: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (server !== undefined) {
    await new Promise<void>((resolve, reject) => server!.close(error => error === undefined ? resolve() : reject(error)))
  }
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Start a deterministic authenticated Frappe-MCP test endpoint. */
async function startFrappeMcp(): Promise<{ endpoint: string; requests: FrappeRequest[] }> {
  const requests: FrappeRequest[] = []
  server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    const body = JSON.parse(raw) as FrappeRequest['body']
    requests.push({ authorization: request.headers.authorization, body })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{ type: 'text', text: `completed ${body.params.name}` }],
        isError: false,
        structuredContent: { operation: body.params.name, rule_set: 'NUTRITION-RULE-0001' },
      },
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Frappe-MCP test server has no TCP address')
  return { endpoint: `http://127.0.0.1:${address.port}/api/method/ione_core.mcp.server.handle_mcp`, requests }
}

/** Boot the real tool composition from a temporary cordis.yml. */
async function loadComposition(endpoint: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tongjianyun-nutrition-tools-'))
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(credentialsPath, [
    'version: 1',
    'refs:',
    '  TONGJIANYUN_MCP_TOKEN: test-key:test-secret',
    '  TONGJIANYUN_ACTOR_TOKEN: test-actor-token',
    '',
  ].join('\n'), { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    watch: false',
    '- id: tongjianyun-nutrition-rules',
    "  name: '@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules'",
    '  config:',
    `    endpoint: ${JSON.stringify(endpoint)}`,
    '    credentialRef: TONGJIANYUN_MCP_TOKEN',
    '    actorTokenRef: TONGJIANYUN_ACTOR_TOKEN',
    '    timeoutMs: 5000',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-tool-tongjianyun-nutrition-rules', NutritionRules],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

/** Execute one model-visible tool through the standard ToolRuntime pipeline. */
function execute(ctx: Context, call: string, name: string, arguments_: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(call),
    name,
    arguments: arguments_,
  })
}

describe('Tongjianyun nutrition-rule Loader composition', () => {
  it('loads eight model-visible tools and routing guidance, resolves secrets at call time, and disposes both', async () => {
    const mock = await startFrappeMcp()
    const ctx = await loadComposition(mock.endpoint)

    expect(ctx.tools.schemas().map(tool => tool.name)).toMatchInlineSnapshot(`
      [
        "tongjianyun_explain_nutrition_standard",
        "tongjianyun_get_weekly_nutrition_analysis",
        "tongjianyun_list_nutrition_rules",
        "tongjianyun_create_nutrition_rule_draft",
        "tongjianyun_preview_nutrition_rule",
        "tongjianyun_submit_nutrition_rule",
        "tongjianyun_publish_nutrition_rule",
        "tongjianyun_rollback_nutrition_rule",
      ]
    `)

    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['explain-standard', 'tongjianyun_explain_nutrition_standard', { metric: 'energy', standard_mode: '自动（按学生档案）' }],
      ['weekly-analysis', 'tongjianyun_get_weekly_nutrition_analysis', { recipe: 'RECIPE-0001', student_groups: ['CLASS-1'] }],
      ['list', 'tongjianyun_list_nutrition_rules', { status: '已发布', limit: 5 }],
      ['draft', 'tongjianyun_create_nutrition_rule_draft', { title: '提高钙目标', changes: { targets: { calcium: 600 } } }],
      ['preview', 'tongjianyun_preview_nutrition_rule', { rule_set: 'NUTRITION-RULE-0001' }],
      ['submit', 'tongjianyun_submit_nutrition_rule', { rule_set: 'NUTRITION-RULE-0001' }],
      ['publish', 'tongjianyun_publish_nutrition_rule', { rule_set: 'NUTRITION-RULE-0001', confirmation: '确认发布' }],
      ['rollback', 'tongjianyun_rollback_nutrition_rule', { target_rule_set: 'NUTRITION-RULE-0000', confirmation: '确认回滚' }],
    ]
    for (const [call, name, arguments_] of cases) {
      const result = await execute(ctx, call, name, arguments_)
      expect(result).toMatchObject({ isError: false, value: { rule_set: 'NUTRITION-RULE-0001' } })
    }

    expect(mock.requests.map(request => request.body.params.name)).toEqual([
      'frappe_explain_tongjianyun_nutrition_standard',
      'frappe_get_tongjianyun_weekly_nutrition_analysis',
      'frappe_list_tongjianyun_nutrition_rules',
      'frappe_create_tongjianyun_nutrition_rule_draft',
      'frappe_preview_tongjianyun_nutrition_rule',
      'frappe_submit_tongjianyun_nutrition_rule',
      'frappe_publish_tongjianyun_nutrition_rule',
      'frappe_rollback_tongjianyun_nutrition_rule',
    ])
    for (const request of mock.requests) {
      expect(request.authorization).toBe('token test-key:test-secret')
      expect(request.body.method).toBe('tools/call')
      expect(request.body.params.arguments).toMatchObject({ actor_token: 'test-actor-token' })
    }

    expect((await ctx.systemPrompt.assemble()).sections.find(
      section => section.name === 'tool:tongjianyun-nutrition',
    )?.text).toMatchInlineSnapshot(`
      "童健云营养业务取证规则：
      - 用户询问“周食谱营养分析”的标准值、全日标准、园内目标或这些数值如何计算时，必须先调用 tongjianyun_explain_nutrition_standard。
      - 用户询问某份或最新食谱的实际营养值、达标情况、食材构成或分析结论时，必须先调用 tongjianyun_get_weekly_nutrition_analysis。
      - 以工具返回的当前生效规则、真实食谱数据、计算明细和标准来源作答；不要先搜索 IONE Harness 自身源码，也不要凭通用营养知识猜测童健云的实现。
      - 工具调用失败时应明确说明无法读取童健云数据，不得编造数值、规则版本或计算依据。"
    `)

    const nutritionEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'tongjianyun-nutrition-rules')
    if (nutritionEntry === undefined) throw new Error('nutrition rules entry is missing')
    await nutritionEntry._dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections.some(
      section => section.name === 'tool:tongjianyun-nutrition',
    )).toBe(false)
  })

  it('rejects destructive operations before transport unless the exact confirmation is present', async () => {
    const mock = await startFrappeMcp()
    const ctx = await loadComposition(mock.endpoint)

    const result = await execute(ctx, 'rejected-publish', 'tongjianyun_publish_nutrition_rule', {
      rule_set: 'NUTRITION-RULE-0001',
      confirmation: '发布',
    })

    expect(result).toMatchObject({
      isError: true,
      error: { message: '发布需要精确确认文本“确认发布”' },
    })
    expect(mock.requests).toEqual([])
  })

  it('rejects a rule-list limit outside the documented server range before transport', async () => {
    const mock = await startFrappeMcp()
    const ctx = await loadComposition(mock.endpoint)

    const result = await execute(ctx, 'rejected-limit', 'tongjianyun_list_nutrition_rules', { limit: 101 })

    expect(result).toMatchObject({
      isError: true,
      error: { message: 'limit 必须是 1 至 100 之间的整数' },
    })
    expect(mock.requests).toEqual([])
  })
})
