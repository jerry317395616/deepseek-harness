/**
 * Permission-aware, read-only Frappe ORM tools for the active Native Bench.
 * @module @deepseek-ai/dsh-tool-native-bench-frappe
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { NativeFrappeClient, resolveNativeFrappeSpec } from './native.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-native-bench-frappe'

/** Services required for local Frappe reads and model-facing routing guidance. */
export const inject = ['tools', 'systemPrompt', 'subprocess']

/** Deployment-owned configuration for the active Native Bench Frappe site. */
export interface Config {
  /** Absolute Native Bench root containing apps and sites. */
  benchRoot?: string
  /** Frappe site initialized by the local adapter. */
  site?: string
  /** Optional Python executable; relative paths resolve under benchRoot. */
  pythonExecutable?: string
  /** Fixed deployment-owned Frappe account used for permission checks. */
  frappeUser?: string
  /** Maximum captured helper output in bytes. */
  maxOutputBytes?: number
  /** Maximum serialized model arguments sent to the helper. */
  maxInputBytes?: number
  /** Cooperative timeout budget for one Frappe read. */
  timeoutMs: number
}

/** Validate deployment-owned Native Bench settings. */
export const Config: z<Config> = z.object({
  benchRoot: z.string().default('/home/zyd/frappe/native-bench'),
  site: z.string().default('child.myyr.top'),
  pythonExecutable: z.string().default(''),
  frappeUser: z.string().default('Administrator'),
  maxOutputBytes: z.number().step(1).min(16_384).max(5_000_000).default(1_000_000),
  maxInputBytes: z.number().step(1).min(16_384).max(1_000_000).default(256_000),
  timeoutMs: z.number().step(1).min(1_000).max(120_000).default(30_000),
})

/** Register bounded, read-only Frappe ORM tools over all permitted DocTypes. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveNativeFrappeSpec(config)
  const client = new NativeFrappeClient(ctx, resolved)

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:native-bench-frappe',
    order: 114,
    text: [
      'Native Bench Frappe 数据规则：',
      '- 需要查询 Native Bench 数据库时，使用 native_bench_frappe_list_documents 或 native_bench_frappe_get_document；这些工具直接在配置的 Frappe 站点 ORM 上下文中执行。',
      '- 工具遵守固定 Frappe 用户的权限和服务端 DocType 拒绝列表；不会执行任意 SQL、Python、站点路径或模型提供的用户。',
      '- 查询字段、过滤条件和排序必须使用结构化参数；结果有行数、字段、输入和输出上限，敏感字段会脱敏。',
      '- 询问童健云营养业务时，先用 Native Bench 源码工具，再使用童健云营养专用工具；通用 Frappe 工具用于其他应用和 DocType。',
      '- 数据库写入、源码修改和运行环境变更必须使用单独的受控管理流程，不得把只读工具当作写入接口。',
    ].join('\n'),
  }))

  const output = {
    schema: { type: 'json' as const },
    render: (_arguments: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_frappe_list_documents',
    description: '在当前 Native Bench 的 Frappe 站点中按权限查询任意允许的 DocType 列表。支持结构化过滤、排序、分页和字段选择；禁止任意 SQL，敏感字段自动脱敏，只读。',
    parameters: {
      doctype: { type: 'string', required: true, description: 'Frappe DocType 名称，例如 Student、Class 或 Course。' },
      fields: { type: 'json', description: '可选字段名数组，最多64个；留空只返回 name。' },
      filters: { type: 'json', description: '可选过滤对象或 [字段, 运算符, 值] 条件数组；不接受 SQL。' },
      order_by: { type: 'string', description: '可选单字段排序，例如 modified desc。' },
      limit: { type: 'integer', description: '返回行数，1至100，默认20。' },
      start: { type: 'integer', description: '分页起点，0至100000，默认0。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => client.call(
      'frappe_list_documents',
      arguments_ as Record<string, JsonValue>,
      exec.signal,
    ),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_frappe_get_document',
    description: '在当前 Native Bench 的 Frappe 站点中按权限读取一个允许的 DocType 记录。支持字段选择和敏感字段脱敏；禁止任意 SQL，只读。',
    parameters: {
      doctype: { type: 'string', required: true, description: 'Frappe DocType 名称。' },
      name: { type: 'string', required: true, description: '记录名称或编号。' },
      fields: { type: 'json', description: '可选字段名数组，最多64个；留空只返回 name。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => client.call(
      'frappe_get_document',
      arguments_ as Record<string, JsonValue>,
      exec.signal,
    ),
  })))
}
