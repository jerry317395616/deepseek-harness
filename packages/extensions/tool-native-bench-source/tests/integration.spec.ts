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
    mkdir(join(root, 'sites'), { recursive: true }),
    mkdir(join(root, 'config'), { recursive: true }),
  ])
  await writeFile(join(root, 'apps', 'tongjianyun', 'tongjianyun', 'nutrition.py'), 'ENERGY_STANDARD = 600\n')
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
})
