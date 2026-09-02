/** Composition tests for the official Frappe documentation tools. */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import * as FrappeDocs from '../src/index.ts'

class StubDocsSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []

  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const operationIndex = spec.argv.indexOf('--operation')
    const operation = operationIndex === -1 ? 'unknown' : spec.argv[operationIndex + 1]
    const output = JSON.stringify({ ok: true, result: { operation, source: 'official-docs-index' } })
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

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function loadDocs(): Promise<{ ctx: Context; subprocess: StubDocsSubprocess }> {
  const ctx = new CordisContext()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubDocsSubprocess)
  await ctx.plugin(FrappeDocs, {
    knowledgeRoot: '/srv/frappe-docs-kb',
    pythonExecutable: '/usr/bin/python3',
    timeoutMs: 5_000,
  })
  return { ctx, subprocess: ctx.get('subprocess') as StubDocsSubprocess }
}

function execute(ctx: Context, call: string, name: string, arguments_: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(call),
    name,
    arguments: arguments_,
  })
}

describe('Frappe documentation composition', () => {
  it('registers search, page and status tools with source-priority guidance', async () => {
    const { ctx } = await loadDocs()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([
      'frappe_docs_search',
      'frappe_docs_get_page',
      'frappe_docs_status',
    ])
    const section = (await ctx.systemPrompt.assemble()).sections.find(candidate => candidate.name === 'tool:frappe-docs')
    expect(section?.text).toContain('先搜索 /home/zyd/frappe/native-bench/apps')
    expect(section?.text).toContain('官方文档只能解释框架与产品规则')
  })

  it('routes a bounded search through the deployment-owned local index', async () => {
    const { ctx, subprocess } = await loadDocs()
    const result = await execute(ctx, 'docs-search', 'frappe_docs_search', {
      query: 'DocType controller hooks',
      product: 'framework',
      version: 'v15',
      language: 'en',
      limit: 6,
    })
    expect(result).toMatchObject({ isError: false, value: { operation: 'search', source: 'official-docs-index' } })
    expect(subprocess.specs).toHaveLength(1)
    const spec = subprocess.specs[0]
    expect(spec?.argv).toEqual([
      resolve('/usr/bin/python3'),
      expect.stringContaining('frappe_docs_kb.py'),
      '--knowledge-root', resolve('/srv/frappe-docs-kb'),
      '--operation', 'search',
      '--max-input-bytes', '64000',
      '--max-output-bytes', '1000000',
    ])
    expect(spec?.cwd).toBe(resolve('/srv/frappe-docs-kb'))
    expect(spec?.stdio.stdin).toMatchObject({
      data: JSON.stringify({ arguments: {
        query: 'DocType controller hooks',
        product: 'framework',
        version: 'v15',
        language: 'en',
        limit: 6,
      } }),
    })
  })

  it('rejects a non-official page URL and oversized result count before spawning', async () => {
    const { ctx, subprocess } = await loadDocs()
    const page = await execute(ctx, 'docs-page-origin', 'frappe_docs_get_page', {
      page: 'https://example.com/framework/user/en/introduction',
    })
    expect(page.isError).toBe(true)
    const search = await execute(ctx, 'docs-search-limit', 'frappe_docs_search', {
      query: 'permissions',
      limit: 21,
    })
    expect(search.isError).toBe(true)
    expect(subprocess.specs).toHaveLength(0)
  })

  it('routes page and status reads without exposing synchronization controls', async () => {
    const { ctx, subprocess } = await loadDocs()
    const page = await execute(ctx, 'docs-page', 'frappe_docs_get_page', {
      page: 'framework/user/en/api/rest',
      heading: 'Authentication',
      max_characters: 12_000,
    })
    expect(page.isError).toBe(false)
    const status = await execute(ctx, 'docs-status', 'frappe_docs_status', {})
    expect(status.isError).toBe(false)
    expect(subprocess.specs.map(spec => spec.argv[spec.argv.indexOf('--operation') + 1])).toEqual([
      'get_page',
      'status',
    ])
    expect(ctx.tools.schemas().some(tool => tool.name.includes('sync'))).toBe(false)
  })
})
