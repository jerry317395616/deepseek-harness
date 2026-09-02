/** Real Loader composition for the Native Bench Frappe platform tools. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeFrappe from '../src/index.ts'

class StubNativeSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []

  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const operationIndex = spec.argv.indexOf('--operation')
    const operation = operationIndex === -1 ? 'unknown' : spec.argv[operationIndex + 1]
    const output = JSON.stringify({ ok: true, result: { operation, source: 'loader-composition' } })
    const outcome: SubprocessOutcome = { exitCode: 0, signal: null }
    return {
      pid: this.specs.length,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: output, nextOffset: output.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve(outcome),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('terminal is not part of this test'))
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-native-bench-frappe-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: native-bench-frappe',
    "  name: '@deepseek-ai/dsh-tool-native-bench-frappe'",
    '  config:',
    '    benchRoot: /active/native-bench',
    '    site: child.myyr.top',
    '    pythonExecutable: /active/native-bench/env/bin/python',
    '    frappeUser: Administrator',
    '    timeoutMs: 5000',
    '',
  ].join('\n'))

  const ctx = new CordisContext()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-native-bench-frappe', NativeFrappe],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.plugin(StubNativeSubprocess)
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('Native Bench Frappe Loader composition', () => {
  it('loads the platform tools and routing guidance, executes discovery, and disposes both', async () => {
    const ctx = await loadComposition()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([
      'native_bench_frappe_platform_catalog',
      'native_bench_frappe_describe_doctype',
      'native_bench_frappe_list_documents',
      'native_bench_frappe_get_document',
      'native_bench_frappe_preview_document_update',
      'native_bench_frappe_apply_document_update',
    ])
    expect((await ctx.systemPrompt.assemble()).sections.find(
      section => section.name === 'tool:native-bench-frappe',
    )?.text).toContain('必须先调用 native_bench_frappe_preview_document_update')

    const catalog = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('platform-catalog'),
      name: 'native_bench_frappe_platform_catalog',
      arguments: { keyword: '学生', limit: 20 },
    })
    expect(catalog).toMatchObject({
      isError: false,
      value: { operation: 'frappe_platform_catalog', source: 'loader-composition' },
    })

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'native-bench-frappe')
    if (entry === undefined) throw new Error('native-bench-frappe entry is missing')
    await entry._dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections.some(
      section => section.name === 'tool:native-bench-frappe',
    )).toBe(false)
  })
})
