/**
 * Model-facing source and runtime evidence tools for the active Frappe Native
 * Bench. The tools keep the active source tree explicit instead of relying on
 * the Harness process working directory.
 * @module @deepseek-ai/dsh-tool-native-bench-source
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { rgPath } from '@vscode/ripgrep'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-fs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-native-bench-source'

/** Services used by source discovery and bounded text reads. */
export const inject = ['tools', 'systemPrompt', 'subprocess', 'fs']

/** Maximum UTF-8 bytes returned for one source file read. */
export const MAX_FILE_BYTES = 512_000

/** Maximum complete ripgrep output retained for one search. */
export const MAX_RAW_OUTPUT_BYTES = 8_000_000

/** Default maximum matches returned by one source search. */
export const MAX_MATCHES = 200

/** Default cooperative timeout for source tools. */
export const SOURCE_TIMEOUT_MS = 30_000

/** Default process termination grace period. */
export const SOURCE_GRACE_MS = 1_000

/** Configuration for the active Native Bench source tree. */
export interface Config {
  /** Absolute Native Bench root containing apps, sites and config. */
  benchRoot: string
  /** App that owns every generated or edited business extension. */
  extensionApp?: string
  /** Maximum matches retained inline by one source search. */
  maxMatches?: number
  /** Maximum bytes retained for one matched-line preview. */
  maxLineBytes?: number
  /** Maximum complete ripgrep output parsed by one search. */
  maxRawOutputBytes?: number
  /** Cooperative timeout applied through the Harness timeout policy. */
  timeoutMs?: number
  /** Ripgrep process termination grace period. */
  graceMs?: number
  /** Maximum complete source file size read by the file tool. */
  maxFileBytes?: number
}

/** Schema for deployment-owned Native Bench paths and output limits. */
export const Config: z<Config> = z.object({
  benchRoot: z.string().required(),
  extensionApp: z.string().default('tongjianyun'),
  maxMatches: z.number().step(1).min(1).max(1000).default(MAX_MATCHES),
  maxLineBytes: z.number().step(1).min(64).max(16_000).default(4_000),
  maxRawOutputBytes: z.number().step(1).min(1_024).max(MAX_RAW_OUTPUT_BYTES).default(MAX_RAW_OUTPUT_BYTES),
  timeoutMs: z.number().step(1).min(1_000).max(120_000).default(SOURCE_TIMEOUT_MS),
  graceMs: z.number().step(1).min(100).max(30_000).default(SOURCE_GRACE_MS),
  maxFileBytes: z.number().step(1).min(1_024).max(MAX_FILE_BYTES).default(MAX_FILE_BYTES),
})

type ResolvedConfig = Required<Config>

interface BenchRoots {
  bench: string
  apps: string
  sites: string
  config: string
}

interface SourceMatch {
  path: string
  lineNumber: number
  line: string
}

interface SearchResult {
  query: string
  searchedRoot: string
  matches: SourceMatch[]
  totalMatches: number
  truncated: boolean
}

type FrappeUiKind = 'page' | 'query-report' | 'workspace' | 'doctype' | 'unresolved'

interface BackendMethodTarget {
  method: string
  path: string | null
}

interface RouteTargetResult {
  input: string
  route_path: string
  route_kind: FrappeUiKind
  route_slug: string
  matched_app: string | null
  target_files: string[]
  frontend_files: string[]
  backend_methods: BackendMethodTarget[]
  target_lock: {
    ready: boolean
    reason: string
  }
  required_next_steps: string[]
}

type ExtensionChangeKind = 'form-ui' | 'list-ui' | 'desk-page' | 'custom-page' | 'add-field' | 'modify-field' | 'business-logic' | 'report' | 'workspace'

interface ExtensionPlanResult {
  change_kind: ExtensionChangeKind
  source: RouteTargetResult
  extension_app: string
  allowed_write_root: string
  upstream_source_files_read_only: string[]
  suggested_extension_files: string[]
  structural_change: boolean
  requires_explicit_confirmation: boolean
  ready: boolean
  rules: string[]
}

const EXTENSION_CHANGE_KINDS = new Set<ExtensionChangeKind>([
  'form-ui',
  'list-ui',
  'desk-page',
  'custom-page',
  'add-field',
  'modify-field',
  'business-logic',
  'report',
  'workspace',
])

const ROUTE_SCAN_IGNORED_DIRECTORIES = new Set([
  '.git',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
])

/** Site credentials and private backups are never model-readable. */
function isSensitivePath(display: string): boolean {
  const normalized = display.replace(/\\/g, '/').toLowerCase()
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return normalized === 'sites/common_site_config.json'
    || normalized.endsWith('/site_config.json')
    || normalized.includes('/private/backups/')
    || /(^|\.)(env|pem|key|crt)$/.test(base)
    || /(secret|password|credential|token|api[-_]?key|private[-_]?key)/.test(base)
}

/** Only common_site_config.json is needed for the non-secret runtime manifest. */
function isRuntimeMetadataPath(display: string): boolean {
  return display.replace(/\\/g, '/') === 'sites/common_site_config.json'
}

/** Remove credential-shaped JSON values while retaining useful runtime metadata. */
function redactRuntimeConfig(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact)
      if (!isRecord(value)) return value
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => (
        /(secret|password|credential|token|api[-_]?key|private[-_]?key|encryption[-_]?key)/i.test(key)
          ? [key, '[redacted]']
          : [key, redact(entry)]
      )))
    }
    return JSON.stringify(redact(parsed), null, 2)
  } catch {
    return '[redacted invalid runtime configuration]'
  }
}

/** Validate and canonicalize the Native Bench directories before registration. */
async function resolveBenchRoots(benchRoot: string): Promise<BenchRoots> {
  if (!isAbsolute(benchRoot)) throw new Error('tool-native-bench-source: benchRoot must be an absolute path')
  const bench = await requireDirectory(benchRoot, 'benchRoot')
  const apps = await requireDirectory(join(bench, 'apps'), 'apps root')
  const sites = await requireDirectory(join(bench, 'sites'), 'sites root')
  const config = await requireDirectory(join(bench, 'config'), 'config root')
  return { bench, apps, sites, config }
}

/** Resolve one existing directory and reject a file or missing path. */
async function requireDirectory(path: string, label: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch (error) {
    throw new Error(`tool-native-bench-source: ${label} does not exist: ${path}`, { cause: error })
  }
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new Error(`tool-native-bench-source: ${label} is not a directory: ${path}`)
  return canonical
}

/** Test canonical path containment without prefix collisions. */
function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Convert an absolute Native Bench path to a stable path shown to the model. */
function displayPath(path: string, roots: BenchRoots): string {
  const rel = relative(roots.bench, path)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

/** Resolve a source path under the configured, read-only allowlist. */
async function resolveReadablePath(path: string, roots: BenchRoots): Promise<{ canonical: string; display: string }> {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('path must be a non-empty string')
  const candidate = isAbsolute(path) ? resolve(path) : resolve(roots.bench, path)
  let canonical: string
  try {
    canonical = await realpath(candidate)
  } catch (error) {
    throw new Error(`Source path does not exist: ${path}`, { cause: error })
  }
  const allowed = [roots.apps, roots.sites, roots.config].some(root => isWithin(canonical, root))
    || canonical === join(roots.bench, 'Procfile')
    || canonical === join(roots.bench, 'patches.txt')
  if (!allowed) {
    throw new Error('Only Native Bench apps, sites, config, Procfile and patches.txt are readable')
  }
  const display = displayPath(canonical, roots)
  if (isSensitivePath(display) && !isRuntimeMetadataPath(display)) {
    throw new Error('Sensitive Native Bench configuration, credentials and backups are not readable')
  }
  return { canonical, display }
}

/** Resolve one app directory without permitting a path outside apps/. */
async function resolveAppRoot(app: string | undefined, roots: BenchRoots): Promise<{ path: string; display: string }> {
  if (app === undefined || app.trim() === '') return { path: roots.apps, display: 'apps' }
  if (!/^[A-Za-z0-9_-]+$/.test(app)) throw new Error('app must be one Native Bench app directory name')
  const resolved = await resolveReadablePath(join('apps', app), roots)
  const info = await stat(resolved.canonical)
  if (!info.isDirectory() || !isWithin(resolved.canonical, roots.apps)) throw new Error(`Native Bench app does not exist: ${app}`)
  return { path: resolved.canonical, display: resolved.display }
}

/** Convert a Desk/App URL or route into decoded Frappe route segments. */
function parseFrappeRoute(input: string): { path: string; segments: string[] } {
  const value = input.trim()
  if (value === '') throw new Error('url_or_route must be a non-empty URL or Frappe route')
  let pathname = value
  try {
    pathname = new URL(value).pathname
  } catch {
    pathname = value.split(/[?#]/, 1)[0] ?? value
  }
  const decoded = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
  const deskIndex = decoded.findIndex(segment => segment === 'desk' || segment === 'app')
  const segments = deskIndex >= 0 ? decoded.slice(deskIndex + 1) : decoded
  return { path: `/${decoded.join('/')}`, segments }
}

/** Match Frappe's filesystem convention for route and document names. */
function frappeSlug(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/** Locate exact section/slug artifacts without searching inside every DocType. */
async function findSectionArtifacts(
  roots: BenchRoots,
  section: Exclude<FrappeUiKind, 'unresolved'>,
  slug: string,
  signal: AbortSignal,
): Promise<string[]> {
  const sectionDirectory = section === 'query-report' ? 'report' : section
  const appEntries = await readdir(roots.apps, { withFileTypes: true })
  const stack = appEntries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => join(roots.apps, entry.name))
  const matches: string[] = []
  while (stack.length > 0) {
    if (signal.aborted) throw new Error('Native Bench route resolution was cancelled')
    const current = stack.pop()
    if (current === undefined) break
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ROUTE_SCAN_IGNORED_DIRECTORIES.has(entry.name)) continue
      if (entry.name === sectionDirectory) {
        const artifactDirectory = join(current, entry.name, slug)
        let artifacts
        try {
          artifacts = await readdir(artifactDirectory, { withFileTypes: true })
        } catch {
          continue
        }
        for (const artifact of artifacts) {
          if (!artifact.isFile()) continue
          const extension = artifact.name.slice(artifact.name.lastIndexOf('.'))
          if (!['.js', '.json', '.py', '.ts', '.tsx', '.vue', '.html'].includes(extension)) continue
          matches.push(displayPath(join(artifactDirectory, artifact.name), roots))
        }
        continue
      }
      stack.push(join(current, entry.name))
    }
  }
  return matches.sort()
}

/** Extract whitelisted Python method names invoked by a Frappe page. */
async function extractBackendMethods(
  files: string[],
  roots: BenchRoots,
  maxFileBytes: number,
): Promise<BackendMethodTarget[]> {
  const methods = new Set<string>()
  const methodPatterns = [
    /\bmethod\s*:\s*["']([A-Za-z0-9_.]+)["']/g,
    /\bfrappe\.call\(\s*["']([A-Za-z0-9_.]+)["']/g,
  ]
  for (const display of files.filter(path => /\.(?:js|ts|tsx|vue)$/.test(path))) {
    const path = join(roots.bench, ...display.split('/'))
    const info = await stat(path)
    if (info.size > maxFileBytes) continue
    const source = await readFile(path, 'utf8')
    for (const pattern of methodPatterns) {
      pattern.lastIndex = 0
      for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
        if (match[1] !== undefined) methods.add(match[1])
      }
    }
  }
  return Promise.all([...methods].sort().map(async method => ({
    method,
    path: await resolvePythonMethodPath(method, roots),
  })))
}

/** Resolve a dotted Frappe method to its Python module when it is app-owned. */
async function resolvePythonMethodPath(method: string, roots: BenchRoots): Promise<string | null> {
  const parts = method.split('.').filter(Boolean)
  if (parts.length < 3) return null
  const app = parts[0]
  if (app === undefined || !/^[A-Za-z0-9_-]+$/.test(app)) return null
  const moduleParts = parts.slice(1, -1)
  const candidate = join(roots.apps, app, app, ...moduleParts) + '.py'
  try {
    const canonical = await realpath(candidate)
    const info = await stat(canonical)
    return info.isFile() && isWithin(canonical, roots.apps) ? displayPath(canonical, roots) : null
  } catch {
    return null
  }
}

/** Resolve the exact Frappe UI entrypoint before any source edit is attempted. */
async function resolveUiRoute(
  roots: BenchRoots,
  config: ResolvedConfig,
  input: string,
  signal: AbortSignal,
): Promise<RouteTargetResult> {
  const route = parseFrappeRoute(input)
  if (route.segments.length === 0) throw new Error('The URL does not contain a Frappe Desk/App route')

  const explicitReport = route.segments[0] === 'query-report'
  const routeName = explicitReport ? route.segments.slice(1).join(' ') : route.segments[0] ?? ''
  const slug = frappeSlug(routeName)
  if (slug === '') throw new Error('The Frappe route cannot be converted to a filesystem slug')

  const kinds: Array<Exclude<FrappeUiKind, 'unresolved'>> = explicitReport
    ? ['query-report']
    : ['page', 'workspace', 'doctype']
  let kind: FrappeUiKind = 'unresolved'
  let targetFiles: string[] = []
  for (const candidateKind of kinds) {
    const files = await findSectionArtifacts(roots, candidateKind, slug, signal)
    if (files.length === 0) continue
    kind = candidateKind
    targetFiles = files
    break
  }

  const appNames = new Set(targetFiles.map(path => path.split('/')[1]).filter((value): value is string => Boolean(value)))
  const matchedApp = appNames.size === 1 ? [...appNames][0] ?? null : null
  const frontendFiles = targetFiles.filter(path => /\.(?:js|ts|tsx|vue|html)$/.test(path))
  const backendMethods = await extractBackendMethods(frontendFiles, roots, config.maxFileBytes)
  const ready = kind !== 'unresolved' && appNames.size === 1 && targetFiles.length > 0
  const reason = ready
    ? `已按路由锁定 ${matchedApp} 应用中的 ${kind} 入口；修改前仍需读取前端渲染函数和后端方法。`
    : kind === 'unresolved'
      ? '未找到与该路由完全匹配的 Page、Report、Workspace 或 DocType 文件，禁止凭标题猜测修改目标。'
      : '同一路由在多个应用中有候选文件，必须先消除歧义。'

  return {
    input,
    route_path: route.path,
    route_kind: kind,
    route_slug: slug,
    matched_app: matchedApp,
    target_files: targetFiles,
    frontend_files: frontendFiles,
    backend_methods: backendMethods,
    target_lock: { ready, reason },
    required_next_steps: ready
      ? [
        '读取 target_files 中控制当前界面渲染的代码。',
        '读取 backend_methods 对应的后端文件并确认数据来源。',
        '只修改已证明处于该调用链中的文件；相似名称的报表不是修改依据。',
        '修改后必须在用户给出的原始路由验证实际界面。',
      ]
      : [
        '继续检查 Frappe 路由注册、Page/Report 元数据或运行站点，不得直接编辑相似名称文件。',
      ],
  }
}

/** Validate a model-selected extension change kind against a closed vocabulary. */
function extensionChangeKind(value: string): ExtensionChangeKind {
  if (!EXTENSION_CHANGE_KINDS.has(value as ExtensionChangeKind)) {
    throw new Error(`change_kind must be one of: ${[...EXTENSION_CHANGE_KINDS].join(', ')}`)
  }
  return value as ExtensionChangeKind
}

/** Build Tongjianyun-owned extension targets from an already resolved route. */
async function planTongjianyunExtension(
  roots: BenchRoots,
  config: ResolvedConfig,
  input: string,
  requestedKind: string,
  signal: AbortSignal,
): Promise<ExtensionPlanResult> {
  const changeKind = extensionChangeKind(requestedKind)
  const source = await resolveUiRoute(roots, config, input, signal)
  const extensionRoot = await resolveAppRoot(config.extensionApp, roots)
  const app = config.extensionApp
  const packageRoot = `${extensionRoot.display}/${app}`
  const moduleRoot = `${packageRoot}/${app}`
  const slug = source.route_slug
  const sourceApp = source.matched_app ?? 'unresolved'
  const structuralChange = changeKind === 'add-field' || changeKind === 'modify-field'
  const suggested = new Set<string>([`${packageRoot}/hooks.py`])

  if (structuralChange) {
    suggested.add(`${packageRoot}/custom/${slug}.json`)
    suggested.add(`${packageRoot}/public/js/${slug}.js`)
  } else if (source.matched_app === app) {
    source.target_files.forEach(path => suggested.add(path))
  } else {
    switch (changeKind) {
      case 'form-ui':
        suggested.add(`${packageRoot}/public/js/${slug}.js`)
        break
      case 'list-ui':
        suggested.add(`${packageRoot}/public/js/${slug}_list.js`)
        break
      case 'desk-page':
        suggested.add(`${packageRoot}/public/js/page_overrides/${slug}.js`)
        break
      case 'custom-page':
        suggested.add(`${moduleRoot}/page/${slug}/${slug}.js`)
        suggested.add(`${moduleRoot}/page/${slug}/${slug}.json`)
        suggested.add(`${moduleRoot}/page/${slug}/${slug}.py`)
        break
      case 'business-logic':
        suggested.add(`${packageRoot}/integrations/${frappeSlug(sourceApp)}/${slug}.py`)
        break
      case 'report':
        suggested.add(`${moduleRoot}/report/${slug}/${slug}.js`)
        suggested.add(`${moduleRoot}/report/${slug}/${slug}.json`)
        suggested.add(`${moduleRoot}/report/${slug}/${slug}.py`)
        break
      case 'workspace':
        suggested.add(`${moduleRoot}/workspace/${slug}/${slug}.json`)
        break
    }
  }
  suggested.add(`${packageRoot}/tests/test_${slug}_extension.py`)

  return {
    change_kind: changeKind,
    source,
    extension_app: app,
    allowed_write_root: extensionRoot.display,
    upstream_source_files_read_only: source.matched_app === app ? [] : source.target_files,
    suggested_extension_files: [...suggested].sort(),
    structural_change: structuralChange,
    requires_explicit_confirmation: structuralChange,
    ready: source.target_lock.ready,
    rules: [
      `允许读取 Native Bench 所有应用；业务源码只允许写入 ${extensionRoot.display}。`,
      '禁止修改 Frappe、Education、ERPNext、IONE Core 等上游应用源码。',
      '禁止新增 DocType，也禁止直接修改任何上游 DocType JSON。',
      structuralChange
        ? '字段结构请求必须先列出目标 DocType、字段、类型、默认值、权限与数据迁移影响，获得用户明确确认后才可通过 Tongjianyun Custom Field/Property Setter fixture 实施。'
        : '当前请求不是字段结构变更，不得顺带创建 Custom Field、Property Setter 或数据库结构变更。',
      '实施后运行相关测试、构建/缓存更新，并在用户原始路由做浏览器验证。',
    ],
  }
}

/** Validate a single positive ripgrep glob. */
function validateInclude(include: string | undefined): void {
  if (include === undefined) return
  if (include.trim() === '' || include.startsWith('!') || include.includes('\0') || include.includes('\n')) {
    throw new Error('include must be one non-empty positive glob')
  }
}

/** Truncate a line while preserving a valid UTF-8 string. */
function previewLine(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line
  let value = line
  while (value.length > 0 && Buffer.byteLength(`${value}…`, 'utf8') > maxBytes) value = value.slice(0, -1)
  return `${value}…`
}

/** Parse the match records emitted by `rg --json`. */
function parseMatches(stdout: string, benchRoot: string, maxMatches: number, maxLineBytes: number): SearchResult['matches'] {
  const matches: SourceMatch[] = []
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine) continue
    let record: unknown
    try {
      record = JSON.parse(rawLine)
    } catch (error) {
      throw new Error('Native Bench search returned malformed JSON', { cause: error })
    }
    if (!isRecord(record) || record.type !== 'match' || !isRecord(record.data)) continue
    const data = record.data
    const pathObject = isRecord(data.path) ? data.path : undefined
    const linesObject = isRecord(data.lines) ? data.lines : undefined
    const path = pathObject?.text
    const lineNumber = data.line_number
    const lines = linesObject?.text
    if (typeof path !== 'string' || typeof lineNumber !== 'number' || typeof lines !== 'string') continue
    const rel = relative(benchRoot, path).split(sep).join('/')
    if (matches.length < maxMatches) {
      matches.push({ path: rel, lineNumber, line: previewLine(lines.replace(/\r?\n$/, ''), maxLineBytes) })
    }
  }
  return matches
}

/** Type guard for JSON records at a process boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Run a fixed ripgrep command against the allowlisted Native Bench path. */
async function searchCode(
  ctx: Context,
  exec: ToolExecution,
  roots: BenchRoots,
  config: ResolvedConfig,
  query: string,
  app: string | undefined,
  include: string | undefined,
): Promise<SearchResult> {
  if (query.trim() === '') throw new Error('query must be a non-empty string')
  validateInclude(include)
  const target = await resolveAppRoot(app, roots)
  const argv = [
    rgPath,
    '--no-config',
    '--json',
    '--fixed-strings',
    `--regexp=${query}`,
    '--glob=!node_modules',
    '--glob=!__pycache__',
    '--glob=!*.pyc',
    '--glob=!*.map',
    ...(include === undefined ? [] : [`--glob=${include}`]),
    '--',
    target.path,
  ]
  if (exec.signal.aborted) throw new Error('Native Bench search was cancelled')
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd: roots.bench,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: config.maxRawOutputBytes },
        stderr: { maxBytes: 16_000 },
      },
      graceMs: config.graceMs,
      signal: exec.signal,
    } satisfies SubprocessSpawnSpec)
  } catch (error) {
    throw new Error('Native Bench search process could not start', { cause: error })
  }
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error) {
    throw new Error('Native Bench search process failed', { cause: error })
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  if (stdout === undefined) throw new Error('Native Bench search produced no output stream')
  if (stdout.lossy) throw new Error('Native Bench search result exceeded its output limit; narrow query or app')
  if (exec.signal.aborted) throw new Error('Native Bench search was cancelled')
  if (outcome.signal !== null || outcome.exitCode === null) throw new Error('Native Bench search was terminated')
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    const stderr = handle.collected.stderr?.readFrom(0).text.trim()
    throw new Error(`Native Bench search failed${stderr ? `: ${stderr.slice(0, 500)}` : ''}`)
  }
  const allMatches = parseMatches(stdout.text, roots.bench, config.maxMatches, config.maxLineBytes)
  const totalMatches = countMatchRecords(stdout.text)
  return {
    query,
    searchedRoot: target.display,
    matches: allMatches,
    totalMatches,
    truncated: totalMatches > allMatches.length,
  }
}

/** Count complete match records without retaining a second copy of line text. */
function countMatchRecords(stdout: string): number {
  let count = 0
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine) continue
    try {
      const record: unknown = JSON.parse(rawLine)
      if (isRecord(record) && record.type === 'match') count++
    } catch {
      // parseMatches reports malformed records with a useful failure message.
    }
  }
  return count
}

/** Read a bounded UTF-8 text file through the configured filesystem provider. */
async function readSourceFile(
  ctx: Context,
  roots: BenchRoots,
  config: ResolvedConfig,
  path: string,
  startLine: number | undefined,
  endLine: number | undefined,
  signal: AbortSignal,
): Promise<{ path: string; content: string; startLine: number; endLine: number; totalLines: number }> {
  const resolved = await resolveReadablePath(path, roots)
  const target: FsTarget = await ctx.fs.resolve(resolved.canonical, { signal })
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined || info.type !== 'file') throw new Error(`Source path is not a regular file: ${path}`)
  if (typeof info.size !== 'number') throw new Error(`Source file size is unavailable: ${path}`)
  if (info.size > config.maxFileBytes) throw new Error(`Source file exceeds the ${config.maxFileBytes}-byte read limit: ${path}`)
  const bytes = await ctx.fs.readBytes(target, signal, config.maxFileBytes)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`Source file is not valid UTF-8 text: ${path}`, { cause: error })
  }
  if (isRuntimeMetadataPath(resolved.display)) text = redactRuntimeConfig(text)
  const lines = text.split(/\r?\n/)
  const first = startLine === undefined ? 1 : startLine
  const last = endLine === undefined ? Math.min(lines.length, first + 199) : endLine
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
    throw new Error('start_line and end_line must be positive integers with end_line >= start_line')
  }
  if (last - first > 499) throw new Error('A source read can return at most 500 lines')
  return {
    path: resolved.display,
    content: lines.slice(first - 1, Math.min(last, lines.length)).map((line, index) => `${first + index}: ${line}`).join('\n'),
    startLine: first,
    endLine: Math.min(last, lines.length),
    totalLines: lines.length,
  }
}

/** Read the non-secret Native Bench runtime manifest. */
async function readRuntimeStatus(
  ctx: Context,
  roots: BenchRoots,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const common = await readSourceFile(ctx, roots, config, 'sites/common_site_config.json', undefined, undefined, signal)
  let parsed: unknown
  try {
    parsed = JSON.parse(common.content.replace(/^\d+: /gm, ''))
  } catch {
    parsed = {}
  }
  const record = isRecord(parsed) ? parsed : {}
  const installedApps = Array.isArray(record.installed_apps) ? record.installed_apps.filter((value): value is string => typeof value === 'string') : []
  return {
    bench_root: roots.bench,
    apps_root: roots.apps,
    sites_root: roots.sites,
    default_site: typeof record.default_site === 'string' ? record.default_site : null,
    installed_apps: installedApps,
    developer_mode: record.developer_mode === 1 || record.developer_mode === true,
    webserver_port: typeof record.webserver_port === 'number' ? record.webserver_port : null,
    socketio_port: typeof record.socketio_port === 'number' ? record.socketio_port : null,
    source_of_truth: 'native-bench/apps',
    note: '站点密钥、数据库密码和令牌不会返回。',
  }
}

/** Register Native Bench source discovery and runtime evidence tools. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  const roots = await resolveBenchRoots(resolved.benchRoot)

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:native-bench-source',
    order: 112,
    text: [
      'Native Bench 源码取证规则：',
      '- 当前运行源码的唯一第一优先级是 /home/zyd/frappe/native-bench/apps；不要把 /workspace 或 frappe-direct 当作当前源码。',
      '- 用户提供 /desk、/app URL 或明确路由时，任何搜索、编辑、清缓存或重启之前都必须先调用 native_bench_resolve_ui_route。',
      '- 禁止仅凭中文页面标题、相似文件名或同名 Report 推断修改目标；必须先建立“原始 URL → UI 类型 → 前端入口 → frappe.call 后端方法”调用链。',
      '- native_bench_resolve_ui_route 的 target_lock.ready 不为 true 时不得编辑；应继续只读取证，消除未解析或多应用歧义。',
      '- 修改任意 Frappe 业务界面或逻辑前，还必须调用 native_bench_plan_tongjianyun_extension；可以读取所有应用，但所有业务源码变更只能写入配置的 Tongjianyun 扩展应用。',
      '- Frappe、Education、ERPNext、IONE Core 等上游应用是只读事实来源，不得直接修改。禁止新增 DocType，禁止直接修改上游 DocType JSON。',
      '- 只有用户明确要求字段结构变更且已预览目标、字段、权限和迁移影响时，才可在 Tongjianyun 中维护 Custom Field/Property Setter fixture；普通 UI 请求不得顺带改结构。',
      '- UI 修改后必须在用户给出的原始路由验证实际显示；只验证 Python 返回值、清除缓存或重启进程不能证明界面修改完成。',
      '- 涉及任意 Native Bench 应用业务逻辑时，先用 native_bench_search_code 搜索，再用 native_bench_read_file 读取上下文。',
      '- 涉及运行配置时使用 native_bench_runtime_status；该工具不会返回站点密钥或数据库密码。',
      '- 涉及数据库时，若通用 Frappe 读取包已启用，使用 native_bench_frappe_list_documents 或 native_bench_frappe_get_document；否则明确说明数据库读取工具未启用。童健云营养问题仍优先使用营养专用工具。',
      '- 源码与数据库不一致时明确指出；工具失败时说明证据不可用，不得用通用知识补造业务结果。',
    ].join('\n'),
  }))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_resolve_ui_route',
    description: '把 Frappe /desk 或 /app URL/路由解析为当前 Native Bench 中准确的 Page、Query Report、Workspace 或 DocType 文件，并提取前端调用的后端方法。任何 UI 修改前必须先调用。只读。',
    parameters: {
      url_or_route: { type: 'string', required: true, description: '用户正在查看的完整 URL 或 Frappe 路由，例如 https://child.example/desk/weekly-recipe-nutrition-sheet。' },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: JsonValue) => {
        const result = value as unknown as RouteTargetResult
        const backend = result.backend_methods.length === 0
          ? ['后端方法：未从前端入口提取到；需要继续读取证。']
          : result.backend_methods.map(item => `后端方法：${item.method}${item.path ? ` → ${item.path}` : '（源码路径未自动解析）'}`)
        return [{
          type: 'text' as const,
          text: [
            `路由：${result.route_path}`,
            `类型：${result.route_kind}`,
            `应用：${result.matched_app ?? '未唯一确定'}`,
            `目标锁定：${result.target_lock.ready ? '已锁定' : '未锁定'}；${result.target_lock.reason}`,
            ...result.target_files.map(path => `目标文件：${path}`),
            ...backend,
            ...result.required_next_steps.map(step => `下一步：${step}`),
          ].join('\n'),
        }]
      },
    },
    timeoutMs: resolved.timeoutMs,
    execute: (args, exec) => resolveUiRoute(roots, resolved, args.url_or_route, exec.signal) as Promise<unknown> as Promise<JsonValue>,
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_plan_tongjianyun_extension',
    description: '解析真实 Frappe 路由，并把界面、字段、报表或业务逻辑修改规划到 Tongjianyun 应用内。返回只读上游来源、允许写入根目录、建议扩展文件和结构变更确认要求。任何业务代码修改前必须调用。只读。',
    parameters: {
      url_or_route: { type: 'string', required: true, description: '用户正在查看的完整 URL 或 Frappe 路由。' },
      change_kind: { type: 'string', required: true, description: '变更类型：form-ui、list-ui、desk-page、custom-page、add-field、modify-field、business-logic、report 或 workspace。' },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: JsonValue) => {
        const result = value as unknown as ExtensionPlanResult
        return [{
          type: 'text' as const,
          text: [
            `目标路由：${result.source.route_path}`,
            `上游来源：${result.source.matched_app ?? '未锁定'} / ${result.source.route_kind}`,
            `扩展应用：${result.extension_app}`,
            `唯一允许写入：${result.allowed_write_root}`,
            `可实施：${result.ready ? '是' : '否'}`,
            `结构变更：${result.structural_change ? '是' : '否'}；明确确认：${result.requires_explicit_confirmation ? '需要' : '不需要'}`,
            ...result.upstream_source_files_read_only.map(path => `只读上游文件：${path}`),
            ...result.suggested_extension_files.map(path => `建议扩展文件：${path}`),
            ...result.rules.map(rule => `规则：${rule}`),
          ].join('\n'),
        }]
      },
    },
    timeoutMs: resolved.timeoutMs,
    execute: (args, exec) => planTongjianyunExtension(
      roots,
      resolved,
      args.url_or_route,
      args.change_kind,
      exec.signal,
    ) as Promise<unknown> as Promise<JsonValue>,
  })))

  const searchOutput = {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: JsonValue) => [{
      type: 'text' as const,
      text: (() => {
        const result = value as unknown as SearchResult
        return result.totalMatches === 0
          ? `未找到“${result.query}”的源码匹配。`
          : [`在 ${result.searchedRoot} 中找到 ${result.totalMatches} 处匹配${result.truncated ? '（仅显示前部分）' : ''}：`, ...result.matches.map(match => `${match.path}:${match.lineNumber}: ${match.line}`)].join('\n')
      })(),
    }],
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_search_code',
    description: '在当前运行的 /home/zyd/frappe/native-bench/apps 中搜索所有应用源码。返回文件路径、行号和匹配行；支持中文关键词。只读。',
    parameters: {
      query: { type: 'string', required: true, description: '要搜索的文字或中文关键词。按字面匹配。' },
      app: { type: 'string', description: '可选应用目录名，例如 tongjianyun、ione_core 或 education。' },
      include: { type: 'string', description: '可选的单个文件 glob，例如 *.py 或 *.json。' },
    },
    output: searchOutput,
    timeoutMs: resolved.timeoutMs,
    execute: (args, exec) => searchCode(
      ctx,
      exec,
      roots,
      resolved,
      args.query,
      args.app,
      args.include,
    ) as Promise<unknown> as Promise<JsonValue>,
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_read_file',
    description: '读取当前 Native Bench apps、sites 或 config 中的源码和配置文件，返回带行号的有限范围。禁止读取环境密钥、日志和数据库密码。只读。',
    parameters: {
      path: { type: 'string', required: true, description: '相对于 /home/zyd/frappe/native-bench 的路径，例如 apps/tongjianyun/tongjianyun/nutrition_standard_service.py。' },
      start_line: { type: 'integer', description: '起始行号，默认从第1行开始。' },
      end_line: { type: 'integer', description: '结束行号，默认最多读取500行。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          startLine: { type: 'integer', required: true },
          endLine: { type: 'integer', required: true },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.path}\n${value.content}` }],
    },
    timeoutMs: resolved.timeoutMs,
    execute: (args, exec) => readSourceFile(ctx, roots, resolved, args.path, args.start_line, args.end_line, exec.signal),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'native_bench_runtime_status',
    description: '读取当前 Native Bench 的安全运行清单，包括 Bench 路径、默认站点、已安装应用和端口；不会返回密钥或数据库密码。只读。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: resolved.timeoutMs,
    execute: (_args, exec) => readRuntimeStatus(ctx, roots, resolved, exec.signal) as Promise<unknown> as Promise<JsonValue>,
  })))
}
