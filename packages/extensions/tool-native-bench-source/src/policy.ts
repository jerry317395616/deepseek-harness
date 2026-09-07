/**
 * Hosted Native Bench tool admission for existing business operations.
 * The Host owns plugin code and configuration; conversation approval cannot
 * enable source execution, deployment, or metadata customization.
 * @module @deepseek-ai/dsh-tool-native-bench-source/policy
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Loader name for the hosted business-only admission policy. */
export const name = 'native-bench-business-policy'

/** The policy uses the execution registry and the logged system prompt. */
export const inject = ['tools', 'systemPrompt']

const ALLOWED_TOOLS = new Set([
  'native_bench_search_code',
  'native_bench_read_file',
  'native_bench_runtime_status',
  'native_bench_resolve_ui_route',
  'native_bench_plan_tongjianyun_extension',
  'native_bench_frappe_platform_catalog',
  'native_bench_frappe_describe_doctype',
  'native_bench_frappe_list_documents',
  'native_bench_frappe_get_document',
  'native_bench_frappe_preview_document_update',
  'native_bench_frappe_apply_document_update',
  'frappe_docs_search',
  'frappe_docs_get_page',
  'frappe_docs_status',
  'tongjianyun_explain_nutrition_standard',
  'tongjianyun_compare_age_group_nutrition_standards',
  'tongjianyun_get_weekly_nutrition_analysis',
  'tongjianyun_list_nutrition_rules',
])

const PLAN_KINDS = new Set(['form-ui', 'list-ui', 'desk-page', 'custom-page', 'report', 'workspace'])
const DENIED = '当前服务只允许已上线的受控业务操作。禁止任意脚本、源码编辑、插件或权限配置、站点迁移及所有 DocType 结构变更；聊天授权不能解除限制。'
const PLAN_DENIED = '禁止新增或修改 DocType、字段、权限和命名规则，也不能自编业务逻辑。只能规划复用 Frappe、ERPNext、Education 已有能力的界面或报表组合；规划不代表已实施。'

function denial(execution: ToolExecution): string | undefined {
  if (!ALLOWED_TOOLS.has(execution.name)) return DENIED
  if (execution.name !== 'native_bench_plan_tongjianyun_extension') return undefined
  const args = execution.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)
    || !('change_kind' in args)
    || typeof args.change_kind !== 'string' || !PLAN_KINDS.has(args.change_kind)) return PLAN_DENIED
  return undefined
}

/**
 * Install a global, monotonic execution denial and matching model guidance.
 * The profile must also deny configuration RPCs and remove generic execution
 * providers. This is not per-user authentication or an OS filesystem sandbox.
 * @param ctx - Host context; do not mount this policy in a user-selected preset.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.guard(denial))
  ctx.on('tools/pre-execute', async (execution, next) => {
    const reason = denial(execution)
    return reason === undefined ? next() : { kind: 'deny', reason }
  })
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'native-bench:business-policy',
    order: 115,
    text: [
      '业务执行范围（服务端强制）：',
      '- 普通用户可以直接提出需求；已上线的查询、分析和受控业务操作按现有权限、校验和审批流程执行，不得另写业务算法。',
      '- 优先复用 Frappe、ERPNext、Education 的现有功能。所有业务扩展源码仅可由受控实现写入 /home/zyd/frappe/native-bench/apps/tongjianyun；其他应用只读。',
      '- 本入口不提供任意源码编辑、Shell、Python、SQL、插件安装或配置修改能力，也不允许通过网络请求或子代理绕过。',
      '- 禁止任何 DocType 新增、修改或删除，包括 DocField、Custom Field、Property Setter、权限、命名规则、fixture、补丁和迁移带来的结构变化。用户在聊天中确认也不能放行。',
      '- 界面和报表需求可以取证并规划；只有已上线的受控执行工具才能实施。缺少执行工具时说明缺口，不能声称已创建、发布或完成。',
      '- 业务记录不是 DocType 定义。现有记录的变更仍须通过应用服务或受控 ORM，保留现有预览、权限校验、审批和审计。',
    ].join('\n'),
  }))
}
