import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as NativeBenchSource from '../src/index.ts'

let root: string
let ctx: Context
let sequence = 0

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-native-bench-source-'))
  await Promise.all([
    mkdir(join(root, 'apps', 'tongjianyun', 'tongjianyun'), { recursive: true }),
    mkdir(join(root, 'apps', 'tongjianyun', 'tongjianyun', 'tongjianyun', 'page', 'weekly_recipe_nutrition_sheet'), { recursive: true }),
    mkdir(join(root, 'apps', 'tongjianyun', 'tongjianyun', 'tongjianyun', 'report', 'weekly_recipe_nutrition_analysis'), { recursive: true }),
    mkdir(join(root, 'apps', 'education', 'education', 'education', 'doctype', 'student'), { recursive: true }),
    mkdir(join(root, 'sites'), { recursive: true }),
    mkdir(join(root, 'config'), { recursive: true }),
  ])
  await writeFile(join(root, 'apps', 'tongjianyun', 'tongjianyun', 'nutrition.py'), 'ENERGY_STANDARD = 600\n')
  await writeFile(
    join(root, 'apps', 'tongjianyun', 'tongjianyun', 'tongjianyun', 'page', 'weekly_recipe_nutrition_sheet', 'weekly_recipe_nutrition_sheet.js'),
    'frappe.call({ method: "tongjianyun.nutrition_sheet.get_nutrition_sheet" })\n',
  )
  await writeFile(
    join(root, 'apps', 'education', 'education', 'education', 'doctype', 'student', 'student.json'),
    JSON.stringify({ doctype: 'DocType', name: 'Student', module: 'Education' }),
  )
  await writeFile(
    join(root, 'apps', 'education', 'education', 'education', 'doctype', 'student', 'student.js'),
    'frappe.ui.form.on("Student", {})\n',
  )
  await writeFile(
    join(root, 'apps', 'tongjianyun', 'tongjianyun', 'tongjianyun', 'page', 'weekly_recipe_nutrition_sheet', 'weekly_recipe_nutrition_sheet.json'),
    JSON.stringify({ page_name: 'weekly-recipe-nutrition-sheet', title: '周食谱营养分析' }),
  )
  await writeFile(
    join(root, 'apps', 'tongjianyun', 'tongjianyun', 'tongjianyun', 'report', 'weekly_recipe_nutrition_analysis', 'weekly_recipe_nutrition_analysis.py'),
    'def execute(filters=None):\n    return [], []\n',
  )
  await writeFile(
    join(root, 'apps', 'tongjianyun', 'tongjianyun', 'nutrition_sheet.py'),
    'def get_nutrition_sheet():\n    return {}\n',
  )
  await writeFile(join(root, 'secret.txt'), 'not allowlisted\n')
  await mkdir(join(root, 'sites', 'child.myyr.top'), { recursive: true })
  await writeFile(join(root, 'sites', 'child.myyr.top', 'site_config.json'), JSON.stringify({
    db_password: 'must-not-leak',
    encryption_key: 'must-not-leak',
  }))
  await writeFile(join(root, 'sites', 'common_site_config.json'), JSON.stringify({
    default_site: 'child.myyr.top',
    installed_apps: ['frappe', 'tongjianyun'],
    webserver_port: 17800,
    socketio_port: 17900,
  }))

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(NativeBenchSource, { benchRoot: root })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function call(name: string, arguments_: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`native-bench-${++sequence}`),
    name,
    arguments: arguments_,
  })
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('Native Bench source tools', () => {
  it('searches and reads the configured Bench, then returns the safe runtime manifest', async () => {
    const search = await call('native_bench_search_code', { query: 'ENERGY_STANDARD', app: 'tongjianyun', include: '*.py' })
    expect(search.isError).toBe(false)
    expect(text(search)).toContain('apps/tongjianyun/tongjianyun/nutrition.py:1')

    const read = await call('native_bench_read_file', { path: 'apps/tongjianyun/tongjianyun/nutrition.py' })
    expect(read.isError).toBe(false)
    expect(text(read)).toContain('1: ENERGY_STANDARD = 600')

    const runtime = await call('native_bench_runtime_status', {})
    expect(runtime.isError).toBe(false)
    expect(runtime.value).toMatchObject({
      default_site: 'child.myyr.top',
      installed_apps: ['frappe', 'tongjianyun'],
      webserver_port: 17800,
    })
  })

  it('rejects paths outside the configured Bench allowlist', async () => {
    const result = await call('native_bench_read_file', { path: 'secret.txt' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Only Native Bench')
  })

  it('rejects site credentials while retaining the sanitized runtime manifest', async () => {
    const result = await call('native_bench_read_file', { path: 'sites/child.myyr.top/site_config.json' })
    expect(result.isError).toBe(true)
    expect(text(result)).not.toContain('must-not-leak')
    expect(text(result)).toContain('Sensitive Native Bench configuration')

    const runtime = await call('native_bench_runtime_status', {})
    expect(runtime.isError).toBe(false)
    expect(text(runtime)).not.toContain('must-not-leak')
  })

  it('resolves an exact Page route instead of a similarly named Query Report', async () => {
    const result = await call('native_bench_resolve_ui_route', {
      url_or_route: 'https://child.myyr.top/desk/weekly-recipe-nutrition-sheet',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      route_kind: 'page',
      route_slug: 'weekly_recipe_nutrition_sheet',
      matched_app: 'tongjianyun',
      target_lock: { ready: true },
      backend_methods: [{
        method: 'tongjianyun.nutrition_sheet.get_nutrition_sheet',
        path: 'apps/tongjianyun/tongjianyun/nutrition_sheet.py',
      }],
    })
    expect(text(result)).toContain('page/weekly_recipe_nutrition_sheet/weekly_recipe_nutrition_sheet.js')
    expect(text(result)).not.toContain('report/weekly_recipe_nutrition_analysis')
  })

  it('resolves an explicit Query Report route independently', async () => {
    const result = await call('native_bench_resolve_ui_route', {
      url_or_route: '/desk/query-report/Weekly%20Recipe%20Nutrition%20Analysis',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      route_kind: 'query-report',
      route_slug: 'weekly_recipe_nutrition_analysis',
      matched_app: 'tongjianyun',
      target_lock: { ready: true },
    })
    expect(text(result)).toContain('report/weekly_recipe_nutrition_analysis/weekly_recipe_nutrition_analysis.py')
  })

  it('plans an upstream DocType field extension only inside Tongjianyun', async () => {
    const result = await call('native_bench_plan_tongjianyun_extension', {
      url_or_route: 'https://child.myyr.top/app/student',
      change_kind: 'add-field',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      extension_app: 'tongjianyun',
      allowed_write_root: 'apps/tongjianyun',
      structural_change: true,
      requires_explicit_confirmation: true,
      ready: true,
      source: {
        route_kind: 'doctype',
        matched_app: 'education',
        target_lock: { ready: true },
      },
    })
    expect(text(result)).toContain('只读上游文件：apps/education/')
    expect(text(result)).toContain('建议扩展文件：apps/tongjianyun/tongjianyun/custom/student.json')
    expect(text(result)).not.toContain('建议扩展文件：apps/education/')
  })

  it('requires explicit approval before running a fixed Tongjianyun deploy action', async () => {
    const result = await call('native_bench_deploy_tongjianyun_extension', {
      action: 'build-assets',
    })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('需要用户逐次批准')
  })
})
