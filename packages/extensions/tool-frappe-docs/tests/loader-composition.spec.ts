/** Real Loader composition for the official Frappe documentation tools. */

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
import * as FrappeDocs from '../src/index.ts'

class StubDocsSubprocess extends SubprocessRuntime {
  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const operationIndex = spec.argv.indexOf('--operation')
    const operation = operationIndex === -1 ? 'unknown' : spec.argv[operationIndex + 1]
    const output = JSON.stringify({ ok: true, result: { operation, source: 'loader-composition' } })
    const outcome: SubprocessOutcome = { exitCode: 0, signal: null }
    return {
      pid: 1,
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
  root = await mkdtemp(join(tmpdir(), 'dsh-frappe-docs-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: frappe-docs',
    "  name: '@deepseek-ai/dsh-tool-frappe-docs'",
    '  config:',
    '    knowledgeRoot: /srv/frappe-docs-kb',
    '    pythonExecutable: /usr/bin/python3',
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
    ['@deepseek-ai/dsh-tool-frappe-docs', FrappeDocs],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.plugin(StubDocsSubprocess)
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('Frappe documentation Loader composition', () => {
  it('loads, executes and disposes the complete read-only tool contribution', async () => {
    const ctx = await loadComposition()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([
      'frappe_docs_search',
      'frappe_docs_get_page',
      'frappe_docs_status',
    ])
    expect((await ctx.systemPrompt.assemble()).sections.find(
      section => section.name === 'tool:frappe-docs',
    )?.text).toContain('最终回答必须给出工具返回的 docs.frappe.io 原始链接')

    const search = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('frappe-docs-search'),
      name: 'frappe_docs_search',
      arguments: { query: 'REST API authentication', product: 'framework' },
    })
    expect(search).toMatchObject({
      isError: false,
      value: { operation: 'search', source: 'loader-composition' },
    })

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'frappe-docs')
    if (entry === undefined) throw new Error('frappe-docs entry is missing')
    await entry._dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections.some(
      section => section.name === 'tool:frappe-docs',
    )).toBe(false)
  })
})
