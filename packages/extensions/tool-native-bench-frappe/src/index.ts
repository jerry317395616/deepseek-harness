/**
 * Permission-aware Frappe discovery, ORM reads, and approved scalar updates
 * for the active Native Bench.
 * @module @deepseek-ai/dsh-tool-native-bench-frappe
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { NativeFrappeClient, resolveNativeFrappeSpec } from './native.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-native-bench-frappe'

/** Services required for local Frappe operations and model-facing routing guidance. */
export const inject = ['tools', 'systemPrompt', 'subprocess']

/** Deployment-owned configuration for the active Native Bench Frappe site. */
export interface Config {
  /** Absolute Native Bench root containing apps and sites. */
  benchRoot?: string
  /** Frappe site initialized by the local adapter. */
  site?: string
  /** Optional Python executable; relative paths resolve under benchRoot. */
  pythonExecutable?: string
  /** Fixed expected Frappe account; only maintenance defaults an empty value to Administrator. */
  frappeUser?: string
  /** Maintenance retains approved updates; business requires a signed, pinned actor and read scope. */
  accessMode?: 'maintenance' | 'business'
  /** Private POSIX file read only by the Frappe helper, never by model-facing tools. */
  actorTokenFile?: string
  /** Explicit DocType allowlist for business reads; Frappe permissions still apply. */
  businessDoctypes?: string[]
  /** Maximum captured helper output in bytes. */
  maxOutputBytes?: number
  /** Maximum serialized model arguments sent to the helper. */
  maxInputBytes?: number
  /** Cooperative timeout budget for one Frappe operation. */
  timeoutMs: number
}

/** Validate deployment-owned Native Bench settings. */
export const Config: z<Config> = z.object({
  benchRoot: z.string().default('/home/zyd/frappe/native-bench'),
  site: z.string().default('child.myyr.top'),
  pythonExecutable: z.string().default(''),
  frappeUser: z.string().default(''),
  accessMode: z.union(['maintenance', 'business'] as const).default('maintenance'),
  actorTokenFile: z.string().default(''),
  businessDoctypes: z.array(z.string()).default([]),
  maxOutputBytes: z.number().step(1).min(16_384).max(5_000_000).default(1_000_000),
  maxInputBytes: z.number().step(1).min(16_384).max(1_000_000).default(256_000),
  timeoutMs: z.number().step(1).min(1_000).max(120_000).default(30_000),
})

/** Register bounded Frappe platform tools over all permitted DocTypes. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveNativeFrappeSpec(config)
  const client = new NativeFrappeClient(ctx, resolved)

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:native-bench-frappe',
    order: 114,
    text: resolved.accessMode === 'business' ? [
      'Native Bench Frappe 业务读取规则：',
      '- 只可描述、列表查询或读取部署允许的 DocType；必须使用明确的 DocType 名称。',
      '- 每次读取都由服务端校验签名登录身份、账号启用状态和 Frappe 权限；不能指定或更换执行账号。',
      '- 不允许修改、预览修改、执行代码或维护操作；缺少授权时报告原因，不得改用其他接口绕过。',
    ].join('\n') : [
      'Native Bench Frappe 数据规则：',
      '- 先用 native_bench_frappe_platform_catalog 确认站点、安装应用和可访问 DocType；用 native_bench_frappe_describe_doctype 读取字段与当前账号权限。',
      '- 需要查询业务文档时，使用 native_bench_frappe_list_documents 或 native_bench_frappe_get_document；这些工具直接在配置的 Frappe 站点 ORM 上下文中执行。',
      '- 工具遵守固定 Frappe 用户的权限和服务端 DocType 拒绝列表；不会执行任意 SQL、Python、站点路径或模型提供的用户。',
      '- 查询字段、过滤条件和排序必须使用结构化参数；结果有行数、字段、输入和输出上限，敏感字段会脱敏。',
      '- 用户明确要求修改现有业务记录时，必须先调用 native_bench_frappe_preview_document_update；只有用户批准完全相同的预览后，才能调用 native_bench_frappe_apply_document_update。执行工具会再次校验预览、权限、字段、文档版本，并运行 Frappe validate、hooks 与 Version 记录。',
      '- 受控写入只支持现有业务文档的标量字段；不得修改 DocType、Custom Field、Property Setter、权限结构、子表或数据库结构。',
      '- 询问童健云营养业务时，先用 Native Bench 源码工具，再使用童健云营养专用工具；通用 Frappe 工具用于其他应用和 DocType。',
      '- 源码修改和运行环境变更必须使用 Git 分支、差异审查、测试、用户批准和可回滚部署流程，不得直接改生产源码。',
    ].join('\n'),
  }))

  ctx.on('tools/pre-execute', async (execution, next): Promise<PreToolDecision> => {
    if (resolved.accessMode === 'business'
      && execution.name.startsWith('native_bench_frappe_')
      && !['native_bench_frappe_describe_doctype', 'native_bench_frappe_list_documents',
        'native_bench_frappe_get_document'].includes(execution.name)) {
      return { kind: 'deny', reason: '当前业务模式仅允许已授权的数据读取。' }
    }
    if (execution.name !== 'native_bench_frappe_apply_document_update') return next()
    return {
      kind: 'ask',
      reason: '将按已生成的预览修改 Frappe 业务记录；该操作会运行文档校验与 hooks，并写入数据库。',
    }
  })

  const output = {
    schema: { type: 'json' as const },
    render: (_arguments: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }

  if (resolved.accessMode === 'maintenance') ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_frappe_platform_catalog',
    description: '读取当前 Native Bench 站点的已安装应用和当前 Frappe 账号可读取的 DocType 目录，并标注读、写和新建权限。目录来自实时 Frappe 元数据，不读取密码或密钥。',
    parameters: {
      keyword: { type: 'string', description: '可选 DocType 或模块名称关键词，支持中文。' },
      limit: { type: 'integer', description: '最多返回的 DocType 数量，1至1000，默认500。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => client.call(
      'frappe_platform_catalog',
      arguments_ as Record<string, JsonValue>,
      exec.signal,
    ),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_frappe_describe_doctype',
    description: '读取一个允许访问的 Frappe DocType 的安全元数据，包括模块、字段、字段类型以及当前账号权限。敏感字段不会返回，只读。',
    parameters: {
      doctype: { type: 'string', required: true, description: 'Frappe DocType 名称。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => client.call(
      'frappe_describe_doctype',
      arguments_ as Record<string, JsonValue>,
      exec.signal,
    ),
  })))

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

  if (resolved.accessMode === 'business') return

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_frappe_preview_document_update',
    description: '预览对一个现有 Frappe 业务文档的标量字段修改。只读取并校验当前记录、字段和写权限，不写数据库；返回绑定当前 modified 状态和请求值的 preview_id。禁止结构、权限、子表和敏感字段变更。',
    parameters: {
      doctype: { type: 'string', required: true, description: '现有业务 DocType 名称。' },
      name: { type: 'string', required: true, description: '现有记录名称或编号。' },
      changes: { type: 'json', required: true, description: '拟修改的标量字段对象，1至32个字段；不接受子表、SQL 或 Python。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => client.call(
      'frappe_preview_document_update',
      arguments_ as Record<string, JsonValue>,
      exec.signal,
    ),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_frappe_apply_document_update',
    description: '经用户一次性批准后应用此前预览的 Frappe 业务文档标量字段修改。必须传入完全相同的 changes 和 preview_id；记录或请求变化会使执行失败。运行 Frappe 权限、validate、hooks 和常规版本记录。',
    parameters: {
      doctype: { type: 'string', required: true, description: '与预览完全相同的业务 DocType。' },
      name: { type: 'string', required: true, description: '与预览完全相同的记录名称或编号。' },
      changes: { type: 'json', required: true, description: '与预览完全相同的标量字段对象。' },
      preview_id: { type: 'string', required: true, description: '预览工具返回的64位 preview_id。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => client.call(
      'frappe_apply_document_update',
      arguments_ as Record<string, JsonValue>,
      exec.signal,
    ),
  })))
}
