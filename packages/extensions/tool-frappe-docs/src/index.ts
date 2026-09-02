/**
 * Model-facing retrieval tools over a synchronized official Frappe
 * documentation knowledge base.
 * @module @deepseek-ai/dsh-tool-frappe-docs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { FrappeDocsClient, resolveFrappeDocsSpec } from './native.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-frappe-docs'

/** Services required for local retrieval and model-facing routing guidance. */
export const inject = ['tools', 'systemPrompt', 'subprocess']

/** Deployment-owned configuration for the local official-docs index. */
export interface Config {
  /** Absolute directory containing frappe-docs.sqlite3. */
  knowledgeRoot?: string
  /** Absolute Python 3 executable used by the packaged helper. */
  pythonExecutable?: string
  /** Maximum captured helper output in bytes. */
  maxOutputBytes?: number
  /** Maximum serialized model arguments sent to the helper. */
  maxInputBytes?: number
  /** Cooperative timeout budget for one local retrieval. */
  timeoutMs: number
}

/** Validate deployment-owned documentation-index settings. */
export const Config: z<Config> = z.object({
  knowledgeRoot: z.string().default('/home/zyd/frappe/frappe-docs-kb'),
  pythonExecutable: z.string().default('/usr/bin/python3'),
  maxOutputBytes: z.number().step(1).min(16_384).max(5_000_000).default(1_000_000),
  maxInputBytes: z.number().step(1).min(4_096).max(256_000).default(64_000),
  timeoutMs: z.number().step(1).min(1_000).max(120_000).default(30_000),
})

/** Register bounded official Frappe documentation retrieval tools. */
export function apply(ctx: Context, config: Config): void {
  const client = new FrappeDocsClient(ctx, resolveFrappeDocsSpec(config))

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:frappe-docs',
    order: 116,
    text: [
      'Frappe 官方文档证据规则：',
      '- 当前站点行为、童健云计算或已安装应用实现问题，先搜索 /home/zyd/frappe/native-bench/apps 的运行源码；当前数据和权限再使用 Native Bench Frappe 工具。官方文档只能解释框架与产品规则，不能替代运行源码或数据库事实。',
      '- 需要 Frappe、ERPNext、Education、HR、CRM、Bench、Desk、API 或其他官方产品用法时，先调用 frappe_docs_search。中文提问可先提取对应英文技术关键词，并按 product、version 或 language 缩小范围。',
      '- 对重要结论调用 frappe_docs_get_page 读取完整相关章节。最终回答必须给出工具返回的 docs.frappe.io 原始链接，并说明产品、文档版本路径或更新时间。',
      '- 官方最新文档与当前 Native Bench 版本不一致时，明确说明差异，并以当前运行源码和站点元数据作为本系统行为的事实来源。',
      '- frappe_docs_status 只用于确认索引覆盖范围和同步时间。文档工具只读本地索引，不访问 Frappe 数据库，也不能同步、修改或发布官方文档。',
    ].join('\n'),
  }))

  const output = {
    schema: { type: 'json' as const },
    render: (_arguments: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'frappe_docs_search',
    description: '搜索本地同步的 Frappe 官方文档知识库。返回有界相关章节、产品、版本、更新时间、摘要和 docs.frappe.io 原始链接；仅用于官方规则与开发文档，不代表当前站点实现或数据。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词或问题；英文 Frappe 技术词通常最准确。' },
      product: { type: 'string', description: '可选产品路径，例如 framework、erpnext、education、hr、crm。' },
      version: { type: 'string', description: '可选文档版本路径，例如 v13、v14、v15；留空搜索全部版本。' },
      language: { type: 'string', description: '可选语言代码，例如 en。' },
      limit: { type: 'integer', description: '返回结果数量，1至20，默认8。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => client.call('search', arguments_ as Record<string, JsonValue>, exec.signal),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'frappe_docs_get_page',
    description: '从本地知识库读取一个已索引的 Frappe 官方文档页面或指定章节。页面必须是 docs.frappe.io 链接或站内路径，返回内容始终有长度上限。',
    parameters: {
      page: { type: 'string', required: true, description: '搜索结果返回的官方 URL，或 framework/user/en/api/rest 形式的站内路径。' },
      heading: { type: 'string', description: '可选章节标题；留空读取页面开头。' },
      max_characters: { type: 'integer', description: '最多返回字符数，1000至50000，默认20000。' },
    },
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => client.call('get_page', arguments_ as Record<string, JsonValue>, exec.signal),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'frappe_docs_status',
    description: '读取本地 Frappe 官方文档知识库的页面数、章节数、产品覆盖、失败数和最近同步时间，不触发网络同步。',
    parameters: {},
    output,
    timeoutMs: config.timeoutMs,
    execute: (arguments_, exec) => client.call('status', arguments_ as Record<string, JsonValue>, exec.signal),
  })))
}
