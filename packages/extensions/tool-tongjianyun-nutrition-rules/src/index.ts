/**
 * Tongjianyun nutrition-rule tools for drafting, testing, reviewing, publishing,
 * and rolling back weekly-menu nutrition calculations.
 * @module @deepseek-ai/dsh-tool-tongjianyun-nutrition-rules
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { NutritionMcpClient, resolveNutritionMcpSpec } from './mcp.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-tongjianyun-nutrition-rules'

/** Services required to register tools and resolve each operation's secret references. */
export const inject = ['tools', 'credentials']

/** Configurable connection facts for one Tongjianyun Frappe MCP endpoint. */
export interface Config {
  /** Absolute Frappe method URL serving the MCP endpoint. */
  endpoint: string
  /** Credential reference whose value is a Frappe `api_key:api_secret` pair. */
  credentialRef: string
  /** Optional short-lived current-user identity reference supplied by trusted site infrastructure. */
  actorTokenRef?: string
  /** Per-operation timeout, applied by the Harness tool timeout policy. */
  timeoutMs: number
}

/** Validate deployment-owned connection settings without ever accepting a secret value. */
export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  credentialRef: z.string().required(),
  actorTokenRef: z.string(),
  timeoutMs: z.number().step(1).min(1_000).max(120_000).default(30_000),
})

/** Register the six audited Tongjianyun nutrition-rule tools. */
export function apply(ctx: Context, config: Config): void {
  const client = new NutritionMcpClient(ctx, resolveNutritionMcpSpec(config))
  const call = (tool: string, arguments_: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue> =>
    client.call(tool, arguments_, signal)
  const output = {
    schema: { type: 'json' as const },
    render: (_arguments: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tongjianyun_list_nutrition_rules',
    description: '列出童健云周食谱营养计算规则及当前生效版本。仅用于查询，不会修改任何计算。',
    parameters: {
      status: { type: 'string', enum: ['草稿', '待审核', '已发布', '已停用'], description: '可选的规则状态筛选。' },
      limit: { type: 'integer', description: '最多返回 1 至 100 条规则，默认 20。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => {
      assertRuleLimit(arguments_.limit)
      return call('frappe_list_tongjianyun_nutrition_rules', arguments_ as Record<string, JsonValue>, exec.signal)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tongjianyun_create_nutrition_rule_draft',
    description: '基于当前或指定版本创建周食谱营养计算规则草稿。草稿不会影响已发布报表；变更必须是结构化的公式、比例、阈值、供能系数或目标字段。',
    parameters: {
      title: { type: 'string', required: true, description: '规则草稿名称。' },
      changes: { type: 'json', required: true, description: '结构化营养计算变更。' },
      base_rule_set: { type: 'string', description: '可选的基础规则编号；留空使用当前生效规则。' },
      change_reason: { type: 'string', description: '变更原因和业务依据。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => call('frappe_create_tongjianyun_nutrition_rule_draft', arguments_ as Record<string, JsonValue>, exec.signal),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tongjianyun_preview_nutrition_rule',
    description: '用真实食谱试算候选营养规则，并与当前规则对比。试算不发布，也不会修改报表数据。',
    parameters: {
      rule_set: { type: 'string', required: true, description: '待试算的营养规则编号。' },
      recipe: { type: 'string', description: '可选的食谱编号；留空使用最新食谱。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => call('frappe_preview_tongjianyun_nutrition_rule', arguments_ as Record<string, JsonValue>, exec.signal),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tongjianyun_submit_nutrition_rule',
    description: '将已试算的营养规则草稿提交审核。此操作不会发布规则。',
    parameters: {
      rule_set: { type: 'string', required: true, description: '待提交审核的草稿规则编号。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => call('frappe_submit_tongjianyun_nutrition_rule', arguments_ as Record<string, JsonValue>, exec.signal),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tongjianyun_publish_nutrition_rule',
    description: '发布已审核的营养规则。仅在用户在当前对话中明确确认后调用；confirmation 必须精确为“确认发布”。童健云后端会再次校验管理员权限和确认文本。',
    parameters: {
      rule_set: { type: 'string', required: true, description: '待发布的已审核规则编号。' },
      confirmation: { type: 'string', required: true, description: '必须精确填写“确认发布”。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => {
      if (arguments_.confirmation !== '确认发布') throw new Error('发布需要精确确认文本“确认发布”')
      return call('frappe_publish_tongjianyun_nutrition_rule', arguments_ as Record<string, JsonValue>, exec.signal)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tongjianyun_rollback_nutrition_rule',
    description: '将历史营养规则复制为新版本并立即发布。仅在用户在当前对话中明确确认后调用；confirmation 必须精确为“确认回滚”。童健云后端会再次校验管理员权限和确认文本。',
    parameters: {
      target_rule_set: { type: 'string', required: true, description: '要恢复的历史规则编号。' },
      confirmation: { type: 'string', required: true, description: '必须精确填写“确认回滚”。' },
      change_reason: { type: 'string', description: '可选的回滚原因。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => {
      if (arguments_.confirmation !== '确认回滚') throw new Error('回滚需要精确确认文本“确认回滚”')
      return call('frappe_rollback_tongjianyun_nutrition_rule', arguments_ as Record<string, JsonValue>, exec.signal)
    },
  })))
}

/** Reject a model-supplied rule-list bound outside the server's supported range. */
function assertRuleLimit(limit: number | undefined): void {
  if (limit === undefined || (limit >= 1 && limit <= 100)) return
  throw new Error('limit 必须是 1 至 100 之间的整数')
}
