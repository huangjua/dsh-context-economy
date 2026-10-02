/**
 * dsh-project-index core
 * ----------------------
 * 增量项目索引：文件树 + 轻量符号表 + import 边，按 mtime/size 自愈（从磁盘真值重建，
 * 不信任过期缓存）；外加"指针式"字节切片读取，用于单行超大文件的低成本精读。
 *
 * 设计对齐 DSH 的 token 经济：查询只返回 路径/行号/短上下文 的指针，不整文件喂给模型。
 */
import {
  readFileSync, existsSync, mkdirSync,
  writeFileSync, renameSync, appendFileSync,
} from 'node:fs'
import {
  join, resolve, relative, sep, extname, dirname, isAbsolute,
} from 'node:path'
import { createHash } from 'node:crypto'
import { IndexJobs } from './index-jobs.js'
import * as asyncFs from 'node:fs/promises'
import { setImmediate as yieldImmediate } from 'node:timers/promises'

/* ────────────────────────── 类型 ────────────────────────── */

export interface FileMeta {
  /** ms-resolution mtime；索引自愈的指纹之一 */
  mtime: number
  size: number
  /** Failed extraction/stat remains dirty even when mtime and size are unchanged. */
  pending?: boolean
}

export interface SymbolHit {
  name: string
  /** 相对 root 的 posix 路径 */
  file: string
  line: number
  kind: string
  /** 抽取时截断的短上下文（≤ maxContextLen），查询零 IO */
  context: string
}

/**
 * 索引持久化形态（v7，保留 v6 的紧凑符号行）：SymbolHit.file → fileList[] 整数引用。
 * 22.6 万条符号重复写完整相对路径占索引体积 67%；唯一文件仅 ~7.7k，
 * 改为 files 表整数 id 引用后索引体积约 -39%，JSON.parse/prepare 同步提速。
 * 内存态与工具输出不变（加载时展开回 SymbolHit.file），工具语义零变化。
 */
export interface SymbolRow {
  /** 符号名 */
  n: string
  /** files 表整数下标 */
  f: number
  /** 行号 */
  l: number
  /** kind */
  k: string
  /** 短上下文 */
  c: string
}

export interface PersistedIndexState {
  version: number
  root: string
  updatedAt: number
  /** Last successful full working-tree verification, separate from index changes. */
  verifiedAt: number
  configFingerprint: string
  files: Record<string, FileMeta>
  /** files 表顺序 = 整数 id（下标）；与 symbols 的 f 字段对应 */
  fileList: string[]
  symbols: SymbolRow[]
  imports: ImportEdge[]
  graph: GraphState | null
}

export interface ImportEdge {
  /** 相对 root 的 posix 路径 */
  from: string
  /** 原始模块引用；增删目标文件时不需要重新读取引用方。 */
  specifier: string
  status: 'resolved' | 'external' | 'outside' | 'unresolved'
  /** 只在 resolved 时存在，且是索引内实际文件的 posix 相对路径。 */
  target?: string
  /** 兼容指针：resolved 时等于 target，其他状态等于原始 specifier。 */
  to: string
  line: number
  context: string
}

export interface IndexState {
  version: number
  root: string
  updatedAt: number
  verifiedAt: number
  configFingerprint: string
  files: Record<string, FileMeta>
  symbols: SymbolHit[]
  imports: ImportEdge[]
  /** Part B：import 图中心度（ensure 时算好落盘，旧缓存 version 不符自然失效重建） */
  graph: GraphState | null
}

/** 图中心度的可持久化形态（Map → 普通 Record 以便 JSON 序列化） */
export interface GraphState {
  indegree: Record<string, number>
  ranks: Record<string, number>
  orphans: string[]
}

/** 图查询输出行：file + indegree/rank + 短上下文（指针式，零 IO） */
export interface GraphRow {
  file: string
  indegree: number
  rank: number
  context: string
}

export interface IndexOptions {
  includeExts: string[]
  skipDirs: string[]
  /** 符号/import 抽取只对 ≤ 该字节数的文件执行（超大文件只进文件树，不抽符号） */
  maxScanBytes: number
  maxContextLen: number
  /** Part D：heal-history 行数封顶（Q4 默认 200；超限删最旧行保留尾部） */
  historyMaxRows?: number
}

export interface ScanReport {
  scannedBytes: number
  rescannedFiles: number
  addedFiles: number
  droppedFiles: number
  totalFiles: number
  symbols: number
  imports: number
  failedFiles: number
  scanErrors: string[]
}

/** Part D：heal-history 一行（= ScanReport + ts + root），~/.dsh/project-index/heal-history.jsonl */
export interface HealRow {
  ts: number
  root: string
  scannedBytes: number
  rescannedFiles: number
  addedFiles: number
  droppedFiles: number
  totalFiles: number
  symbols: number
  imports: number
}

export const INDEX_VERSION = 7
const PARSER_VERSION = 'lightweight-002-3-unified-imports'

export function normalizeIndexOptions(opts: IndexOptions): IndexOptions {
  return {
    ...opts,
    includeExts: [...new Set(opts.includeExts.map((e) => {
      const ext = e.trim().toLowerCase()
      return ext.startsWith('.') ? ext : '.' + ext
    }).filter((e) => e !== '.'))].sort(),
    skipDirs: [...new Set(opts.skipDirs.map((s) => s.trim()).filter(Boolean))].sort(),
  }
}

export function indexFingerprint(opts: IndexOptions): string {
  const normalized = normalizeIndexOptions(opts)
  return createHash('sha256').update(JSON.stringify({
    parser: PARSER_VERSION,
    includeExts: normalized.includeExts,
    skipDirs: normalized.skipDirs,
    maxScanBytes: normalized.maxScanBytes,
    maxContextLen: normalized.maxContextLen,
  })).digest('hex')
}

/* ────────────────────────── 工具函数 ────────────────────────── */

function posixify(rel: string): string {
  return rel.split(sep).join('/')
}

export function cwdAbs(p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(p)
}

export function rootHash(root: string): string {
  return createHash('sha1').update(resolve(root)).digest('hex').slice(0, 12)
}

export function estimateTokens(chars: number): number {
  // 粗估计：约 4 字符/token（混合代码/中文时偏保守，用于对比基线足够）
  return Math.max(1, Math.ceil(chars / 4))
}

/* ────────────────────────── 图中心度（Part B）────────────────────────── */

/**
 * PageRank 直译（来源登记见 README"借鉴来源登记（Part B）"）：
 *   paul-gauthier/aider `repomap.py`（Apache-2.0）所用 networkx
 *   `_pagerank_python`（BSD-3-Clause，aider repomap.py L382 注释所引）——
 *   稀疏邻接 + 阻尼 0.85 + 收敛阈值 N*1e-6 + 迭代封顶 100，纯 JS 重写，未逐行复制源码。
 * 与 networkx 默认配置同构：无 personalization → 均匀分布；dangling 节点按
 * personalization 均匀分配（danglesum/N）；收敛判据 err < N*tol（L1 范数）。
 */
export interface PageRankOptions {
  alpha?: number
  tol?: number
  maxIter?: number
}

export interface PageRankResult {
  ranks: Map<string, number>
  iterations: number
  converged: boolean
}

export function pageRank(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
  opts: PageRankOptions = {},
): PageRankResult {
  const alpha = opts.alpha ?? 0.85
  const tol = opts.tol ?? 1e-6
  const maxIter = Math.max(1, Math.floor(opts.maxIter ?? 100))
  const N = nodes.length
  if (N === 0) return { ranks: new Map(), iterations: 0, converged: true }

  const nodeSet = new Set(nodes)
  const outLinks = new Map<string, string[]>()
  const outDeg = new Map<string, number>()
  for (const n of nodes) {
    outLinks.set(n, [])
    outDeg.set(n, 0)
  }
  for (const e of edges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue
    outLinks.get(e.from)!.push(e.to)
    outDeg.set(e.from, outDeg.get(e.from)! + 1)
  }
  const dangling = nodes.filter((n) => outDeg.get(n) === 0)
  const base = 1 / N
  const damp = 1 - alpha
  const dampBase = damp / N
  let x = new Map<string, number>(nodes.map((n) => [n, base])) // uniform nstart
  let converged = false
  let iterations = 0
  for (; iterations < maxIter; iterations++) {
    const xlast = x
    let danglesum = 0
    for (const n of dangling) danglesum += xlast.get(n)!
    danglesum *= alpha
    // 每个节点先收"teleport + dangling"（networkx：x[n] += danglesum*p[n] + (1-alpha)*p[n]）
    const xnew = new Map<string, number>(nodes.map((n) => [n, danglesum * base + dampBase]))
    for (const n of nodes) {
      const deg = outDeg.get(n)!
      if (deg === 0) continue
      const share = (alpha * xlast.get(n)!) / deg // 无权边 stochastic 权重 = 1/out_degree
      for (const nbr of outLinks.get(n)!) xnew.set(nbr, xnew.get(nbr)! + share)
    }
    let err = 0
    for (const n of nodes) err += Math.abs(xnew.get(n)! - xlast.get(n)!)
    x = xnew
    if (err < N * tol) {
      converged = true
      break
    }
  }
  return { ranks: x, iterations: iterations + (converged ? 1 : 0), converged }
}

export interface GraphResult {
  indegree: Map<string, number>
  ranks: Map<string, number>
  orphans: string[]
}

/**
 * 在 import 边上构建图：入度、PageRank 中心度、孤立文件（in=0 且 out=0）。
 * allFiles 提供全节点集（索引内全部文件，含无边的孤立文件）；缺省退化为 import 端点集。
 * 外部 specifier（如 'node:fs'、包名）不在节点集内，其边被忽略。
 */
export function buildGraph(imports: ImportEdge[], allFiles?: string[]): GraphResult {
  const nodes = allFiles !== undefined
    ? [...allFiles]
    : [...new Set([...imports.map((e) => e.from), ...imports.flatMap((e) => e.status === 'resolved' && e.target ? [e.target] : [])])]
  const nodeSet = new Set(nodes)
  const indegree = new Map<string, number>(nodes.map((n) => [n, 0]))
  const outDeg = new Map<string, number>(nodes.map((n) => [n, 0]))
  const uncertain = new Set<string>()
  const edges: Array<{ from: string; to: string }> = []
  for (const e of imports) {
    // Graph and incoming queries consume the same resolved target. Never guess a node
    // from an arbitrary filename prefix, or turn a bare external package into a local edge.
    const to = e.status === 'resolved' ? e.target : undefined
    if (!nodeSet.has(e.from)) continue
    if (!to || !nodeSet.has(to)) { uncertain.add(e.from); continue }
    edges.push({ from: e.from, to })
    indegree.set(to, indegree.get(to)! + 1)
    outDeg.set(e.from, outDeg.get(e.from)! + 1)
  }
  const orphans = nodes.filter((n) => indegree.get(n) === 0 && outDeg.get(n) === 0 && !uncertain.has(n)).sort()
  const { ranks } = pageRank(nodes, edges)
  return { indegree, ranks, orphans }
}

/** 匹配度分组：完整命中名(0) > 前缀(1) > 子串/反向包含(2)。ranking 只作组内并列排序键。 */
function matchQuality(symName: string, q: string): number {
  const n = symName.toLowerCase()
  if (n === q) return 0
  if (n.startsWith(q)) return 1
  return 2
}

/* ────────────────────────── 符号 / import 抽取 ────────────────────────── */

interface Pattern {
  kind: string
  re: RegExp
}

const JS_STYLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

function jsPatterns(): Pattern[] {
  return [
    { kind: 'function', re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm },
    { kind: 'class', re: /^[ \t]*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'const', re: /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|\:)/gm },
    { kind: 'type', re: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm },
    { kind: 'interface', re: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
  ]
}

const PY_STYLE = new Set(['.py'])
const GO_STYLE = new Set(['.go'])
const RS_STYLE = new Set(['.rs'])

function patternsFor(ext: string): Pattern[] {
  if (JS_STYLE.has(ext)) return jsPatterns()
  if (PY_STYLE.has(ext)) {
    return [
      { kind: 'function', re: /^[ \t]*(?:async\s+)?def\s+(\w+)/gm },
      { kind: 'class', re: /^[ \t]*class\s+(\w+)/gm },
    ]
  }
  if (GO_STYLE.has(ext)) {
    return [
      { kind: 'func', re: /^[ \t]*func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
      { kind: 'type', re: /^[ \t]*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm },
    ]
  }
  if (RS_STYLE.has(ext)) {
    return [
      { kind: 'fn', re: /^[ \t]*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm },
      { kind: 'type', re: /^[ \t]*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/gm },
    ]
  }
  return [
    { kind: 'function', re: /^[ \t]*(?:export\s+|public\s+|private\s+|protected\s+)?(?:static\s+|async\s+)?(?:function|def|fn)\s+([A-Za-z_]\w*)/gm },
    { kind: 'class', re: /^[ \t]*(?:export\s+|public\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/gm },
  ]
}

export function extractSymbols(text: string, ext: string, maxContextLen: number): Omit<SymbolHit, 'file'>[] {
  const out: Omit<SymbolHit, 'file'>[] = []
  const seen = new Set<string>()
  // 行号用「换行位置预扫描 + 二分」：O(text + matches·log lines)。
  // 旧实现对每个匹配都 `text.slice(0, i).split('\n')`（O(text)），大文件 × 多匹配是平方级。
  const lineOf = makeLineLookup(text)
  for (const p of patternsFor(ext)) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(text)) !== null) {
      const name = m[1]
      if (!name) continue
      // Name token can follow a multiline export/modifier; use its actual position.
      const line = lineOf(m.index + m[0].lastIndexOf(name))
      const key = name + '|' + p.kind + '|' + line
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        name,
        line,
        kind: p.kind,
        context: m[0].trim().slice(0, maxContextLen),
      })
    }
  }
  return out
}

/**
 * 行号查找表：一次遍历记录所有 '\n' 的偏移，`lineOf(i)` 二分取「i 之前的换行数 + 1」。
 * 行号语义与旧 `text.slice(0, i).split('\n').length` 完全一致（1 起、含 i 所在行）。
 */
function makeLineLookup(text: string): (index: number) => number {
  const breaks: number[] = []
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) breaks.push(i)
  return (index: number): number => {
    let lo = 0
    let hi = breaks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (breaks[mid] < index) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }
}

/** Deterministic, index-only resolution. Candidate order is independent of directory traversal. */
export function resolveSpecifier(root: string, fromFile: string, specifier: string,
  files: ReadonlySet<string> = new Set()): Pick<ImportEdge, 'specifier' | 'status' | 'target' | 'to'> {
  const result = (status: ImportEdge['status'], target?: string) => ({
    specifier, status, to: target ?? specifier, ...(target === undefined ? {} : { target }),
  })
  const ext = extname(fromFile).toLowerCase()
  const python = PY_STYLE.has(ext)
  const spec = specifier.replace(/\\/g, '/')
  let abs: string
  if (python) {
    const level = spec.match(/^\.+/)?.[0].length ?? 0
    const module = spec.slice(level)
    // `from . import name` needs imported-name/package analysis, outside the lightweight grammar.
    if (!module || !/^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*$/.test(module)) return result('unresolved')
    let base = level ? dirname(join(root, fromFile)) : root
    for (let i = 1; i < level; i++) base = dirname(base)
    abs = resolve(base, module.replace(/\./g, '/'))
  } else {
    if (/^(?:@\/|~\/|#)/.test(spec)) return result('unresolved') // unsupported project/package aliases
    const relativeSpec = spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')
    if (!relativeSpec && !isAbsolute(spec)) return result('external')
    abs = resolve(dirname(join(root, fromFile)), spec)
  }
  const rel = posixify(relative(root, abs))
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return result('outside')
  const tsSource = ['.ts', '.tsx', '.mts', '.cts'].includes(ext)
  const sourceExts = tsSource
    ? ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json']
    : ['.js', '.jsx', '.ts', '.tsx', '.d.ts', '.mjs', '.cjs', '.mts', '.cts', '.json']
  let candidates: string[]
  if (python) candidates = [rel + '.py', rel + '/__init__.py']
  else {
    const targetExt = extname(rel).toLowerCase()
    const substitutions: Record<string, string[]> = tsSource ? {
      '.js': ['.ts', '.tsx', '.d.ts', '.js', '.jsx'],
      '.jsx': ['.tsx', '.d.ts', '.jsx'],
      '.mjs': ['.mts', '.d.mts', '.mjs'],
      '.cjs': ['.cts', '.d.cts', '.cjs'],
    } : {}
    if (substitutions[targetExt]) {
      const stem = rel.slice(0, -targetExt.length)
      candidates = substitutions[targetExt].map((e) => stem + e)
    } else if (targetExt) candidates = [rel]
    else {
      const base = rel ? rel + '/' : ''
      candidates = [rel, ...sourceExts.map((e) => rel + e), ...sourceExts.map((e) => base + 'index' + e)]
    }
    if (targetExt) candidates.push(...sourceExts.map((e) => rel + '/index' + e))
  }
  for (const candidate of candidates) if (files.has(candidate)) return result('resolved', candidate)
  return result('unresolved')
}

export function extractImports(text: string, root: string, file: string, ext: string, maxContextLen: number): Omit<ImportEdge, 'from'>[] {
  const out: Omit<ImportEdge, 'from'>[] = []
  const seen = new Set<string>()
  // 与 extractSymbols 同一套行号查找表（旧实现每个匹配 O(text) 重切前缀）
  const lineOf = makeLineLookup(text)
  const ctx = (i: number): string => {
    const end = text.indexOf('\n', i)
    return text.slice(text.lastIndexOf('\n', i - 1) + 1, end < 0 ? text.length : end).trim().slice(0, maxContextLen)
  }

  if (JS_STYLE.has(ext)) {
    const res: [RegExp, number][] = [
      [/^[ \t]*import\s+(?:[\w$*{},\s\n/]+\s+from\s+)?['"]([^'"]+)['"]/gm, 1],
      [/^[ \t]*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm, 1],
      [/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, 1],
      [/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, 1],
    ]
    for (const [re] of res) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const spec = m[1] || ''
        if (!spec) continue
        const line = lineOf(m.index)
        const resolved = resolveSpecifier(root, file, spec)
        const key = spec + '|' + line
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ ...resolved, line, context: ctx(m.index) })
      }
    }
  } else if (PY_STYLE.has(ext)) {
    const res: [RegExp][] = [
      [/^[ \t]*from\s+(\S+)\s+import\b/gm],
      [/^[ \t]*import\s+(\S+)/gm],
    ]
    for (const [re] of res) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const spec = (m[1] || '').trim()
        if (!spec) continue
        const resolved = resolveSpecifier(root, file, spec)
        const line = lineOf(m.index)
        const key = spec + '|' + line
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ ...resolved, line, context: ctx(m.index) })
      }
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

/* ────────────────────────── 文件树遍历 ────────────────────────── */

/* ────────────────────────── 索引器 ────────────────────────── */

export function emptyState(root: string, opts: IndexOptions): IndexState {
  return { version: INDEX_VERSION, root: resolve(root), updatedAt: 0, verifiedAt: 0,
    configFingerprint: indexFingerprint(opts), files: {}, symbols: [], imports: [], graph: null }
}

/** boost 路径规范化：绝对路径 → relative(root)（不在 root 下则跳过）、strip 前导 './'、
 *  posixify 后转小写比对（Windows 大小写不敏感）；任何一步失败返回 null（该项跳过） */
function normalizeBoostPath(root: string, p: string): string | null {
  try {
    let rel: string
    if (isAbsolute(p)) {
      const r = relative(root, resolve(p))
      if (!r || r.startsWith('..') || isAbsolute(r)) return null
      rel = r
    } else {
      rel = p
      while (rel.startsWith('./')) rel = rel.slice(2)
    }
    rel = posixify(rel).toLowerCase()
    return rel === '' ? null : rel
  } catch {
    return null
  }
}

export interface IndexIO { readText(path: string, signal: AbortSignal): Promise<string> }

export class ProjectIndexer {
  readonly root: string
  readonly cacheFile: string
  readonly verificationFile: string
  /** Part D：heal-history 文件（多 root 共享，行内带 root） */
  readonly historyFile: string
  /** Part D：本进程内 cacheFile 解析失败次数（自愈重建的次数提示） */
  cacheCorruptCount = 0
  private readonly opts: IndexOptions
  private readonly io: IndexIO
  private state: IndexState
  private loaded = false
  private contexts = new Map<string, string>()
  private queue: Promise<void> = Promise.resolve()
  private readonly calls = new Set<AbortController>()
  private disposed = false
  lastReport: ScanReport | null = null
  cacheWriteError = ''
  cacheInvalidReason = ''
  /** Diagnostic operation counts; tests assert work instead of flaky timing thresholds. */
  readonly diagnostics = { contextBuilds: 0, contextRowsVisited: 0, contextLookups: 0, activeWorkers: 0, refreshes: 0 }

  constructor(root: string, cacheDir: string, opts: IndexOptions, io: Partial<IndexIO> = {}) {
    this.root = cwdAbs(root)
    this.cacheFile = join(cacheDir, 'index-' + rootHash(this.root) + '.json')
    this.verificationFile = join(cacheDir, 'verified-' + rootHash(this.root) + '.json')
    this.historyFile = join(cacheDir, 'heal-history.jsonl')
    this.opts = normalizeIndexOptions(opts)
    this.io = { readText: (p, signal) => asyncFs.readFile(p, { encoding: 'utf8', signal }), ...io }
    // Large cache parse/validation is deferred to the first async refresh, off the host thread.
    this.state = emptyState(this.root, this.opts)
  }

  get status() {
    return {
      root: this.state.root, files: Object.keys(this.state.files).length,
      symbols: this.state.symbols.length, imports: this.state.imports.length,
      updatedAt: this.state.updatedAt, verifiedAt: this.state.verifiedAt,
      pendingFiles: Object.values(this.state.files).filter((f) => f.pending).length,
      cacheWriteError: this.cacheWriteError, cacheInvalidReason: this.cacheInvalidReason,
    }
  }

  /** Serialize refreshes for one root. A queued cancellation cannot perform later writes. */
  ensure(signal?: AbortSignal): Promise<ScanReport> {
    if (this.disposed) return Promise.reject(new Error('indexer disposed'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    this.calls.add(controller)
    const task = this.queue.then(() => {
      combined.throwIfAborted()
      return this.refresh(combined)
    }).finally(() => { this.calls.delete(controller) })
    this.queue = task.then(() => {}, () => {})
    return task
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const c of this.calls) c.abort(new Error('indexer disposed'))
    await this.queue
  }

  private async buildContexts(state: IndexState, signal: AbortSignal): Promise<Map<string, string>> {
    const contexts = new Map<string, string>()
    let visits = 0
    for (const s of state.symbols) {
      if (!contexts.has(s.file)) contexts.set(s.file, `${s.file}:${s.line} (${s.kind}) ${s.name} — ${s.context}`)
      if (++visits % 1024 === 0) { await yieldImmediate(); signal.throwIfAborted() }
    }
    for (const e of state.imports) {
      if (!contexts.has(e.from)) contexts.set(e.from, `${e.from}:${e.line} → ${e.to} — ${e.context}`)
      if (++visits % 1024 === 0) { await yieldImmediate(); signal.throwIfAborted() }
    }
    this.diagnostics.contextRowsVisited += visits
    this.diagnostics.contextBuilds++
    return contexts
  }

  /** Temp writes are async; only a final guarded, small rename commits the derived cache. */
  private async save(state: IndexState, jobs: IndexJobs | undefined, signal: AbortSignal): Promise<void> {
    // Clean ticks persist only a small, generation-bound verification record.
    const target = jobs ? this.cacheFile : this.verificationFile
    const tmp = target + '.tmp-' + createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 8)
    let committed = false
    try {
      const encoded = jobs ? await jobs.run<string>('encode', state, signal) : JSON.stringify({
        version: 1, root: state.root, configFingerprint: state.configFingerprint,
        updatedAt: state.updatedAt, verifiedAt: state.verifiedAt,
      })
      await asyncFs.mkdir(dirname(target), { recursive: true })
      signal.throwIfAborted()
      await asyncFs.writeFile(tmp, encoded, { encoding: 'utf8', signal })
      signal.throwIfAborted()
      // No await between the cancellation check and rename, so abort/dispose cannot interleave.
      renameSync(tmp, target)
      committed = true
      this.cacheWriteError = ''
    } catch (e) {
      if (signal.aborted) throw signal.reason
      this.cacheWriteError = e instanceof Error ? e.message : String(e)
    } finally {
      if (!committed) {
        try { await asyncFs.unlink(tmp) } catch { /* only our unique temporary file */ }
      }
    }
  }

  private async refresh(signal: AbortSignal): Promise<ScanReport> {
    let jobs: IndexJobs | undefined
    const getJobs = () => {
      if (!jobs) { jobs = new IndexJobs(); this.diagnostics.activeWorkers++ }
      return jobs
    }
    this.diagnostics.refreshes++
    try {
      let previous = this.state
      if (!this.loaded) {
        const loaded = await getJobs().run<{ state: IndexState; corrupt: boolean; reason: string }>('load', {
          root: this.root, cacheFile: this.cacheFile, verificationFile: this.verificationFile, opts: this.opts,
        }, signal)
        previous = loaded.state
        if (loaded.corrupt) this.cacheCorruptCount++
        this.cacheInvalidReason = loaded.reason
      }
      try { await asyncFs.access(this.root) } catch { throw new Error('root 不存在: ' + this.root) }
      signal.throwIfAborted()
      const files: Record<string, FileMeta> = Object.create(null)
      const changedAbs = new Map<string, string>()
      const scanErrors: string[] = []
      let addedFiles = 0
      // Directory I/O and stat never block the main thread. Failed directory walks abort the
      // refresh, preserving the last committed generation instead of deleting unseen files.
      const stack = [this.root]
      const exts = new Set(this.opts.includeExts)
      const skip = new Set(this.opts.skipDirs)
      while (stack.length) {
        signal.throwIfAborted()
        const dir = stack.pop()!
        const entries = await asyncFs.readdir(dir, { withFileTypes: true })
        let visits = 0
        for (const entry of entries) {
          if (++visits % 128 === 0) { await yieldImmediate(); signal.throwIfAborted() }
          const abs = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!skip.has(entry.name)) stack.push(abs)
          } else if (entry.isFile() && exts.has(extname(entry.name).toLowerCase())) {
            const rel = posixify(relative(this.root, abs))
            const prev = previous.files[rel]
            let meta: FileMeta
            try {
              const st = await asyncFs.stat(abs)
              meta = { mtime: st.mtimeMs, size: st.size }
            } catch {
              scanErrors.push(rel + ': stat failed')
              if (prev) files[rel] = { ...prev, pending: true }
              continue
            }
            files[rel] = meta
            if (!prev) addedFiles++
            if (!prev || prev.pending || prev.mtime !== meta.mtime || prev.size !== meta.size) changedAbs.set(rel, abs)
          }
        }
      }
      const names = Object.keys(files)
      const droppedFiles = Object.keys(previous.files).filter((rel) => !(rel in files)).length
      const dirty = droppedFiles > 0 || changedAbs.size > 0 || !previous.graph || scanErrors.length > 0
      let scannedBytes = 0
      let rescannedFiles = 0
      let candidate = previous
      const contextChanges = new Map<string, string | null>()
      if (dirty) {
        for (const rel of Object.keys(previous.files)) if (!(rel in files)) contextChanges.set(rel, null)
        const prevSyms = new Map<string, SymbolHit[]>()
        const prevImps = new Map<string, ImportEdge[]>()
        let visits = 0
        for (const s of previous.symbols) {
          const a = prevSyms.get(s.file)
          if (a) a.push(s); else prevSyms.set(s.file, [s])
          if (++visits % 1024 === 0) { await yieldImmediate(); signal.throwIfAborted() }
        }
        for (const e of previous.imports) {
          const a = prevImps.get(e.from)
          if (a) a.push(e); else prevImps.set(e.from, [e])
          if (++visits % 1024 === 0) { await yieldImmediate(); signal.throwIfAborted() }
        }
        const symbols: SymbolHit[] = []
        const imports: ImportEdge[] = []
        const symbolFiles = new Set<string>()
        let batch: Array<{ text: string; rel: string; ext: string }> = []
        let batchBytes = 0
        const flush = async () => {
          if (!batch.length) return
          const results = await getJobs().run<Array<{ rel: string; symbols: Omit<SymbolHit, 'file'>[]; imports: Omit<ImportEdge, 'from'>[] }>>('extract', {
            files: batch, root: this.root, maxContextLen: this.opts.maxContextLen,
          }, signal)
          for (const result of results) {
            const firstSymbol = result.symbols[0]
            const firstImport = result.imports[0]
            contextChanges.set(result.rel, firstSymbol
              ? `${result.rel}:${firstSymbol.line} (${firstSymbol.kind}) ${firstSymbol.name} — ${firstSymbol.context}`
              : firstImport ? `${result.rel}:${firstImport.line} → ${firstImport.to} — ${firstImport.context}` : null)
            for (const s of result.symbols) {
              symbols.push({ ...s, file: result.rel })
              symbolFiles.add(result.rel)
              if (++visits % 1024 === 0) { await yieldImmediate(); signal.throwIfAborted() }
            }
            for (const e of result.imports) imports.push({ ...e, from: result.rel })
          }
          batch = []; batchBytes = 0
        }
        for (const rel of names) {
          signal.throwIfAborted()
          if (!changedAbs.has(rel)) {
            // Avoid spread argument limits for a file with a very large symbol table.
            for (const s of prevSyms.get(rel) ?? []) {
              symbols.push(s)
              symbolFiles.add(rel)
              if (++visits % 1024 === 0) { await yieldImmediate(); signal.throwIfAborted() }
            }
            for (const e of prevImps.get(rel) ?? []) imports.push(e)
            continue
          }
          const meta = files[rel]
          if (meta.size > this.opts.maxScanBytes) { contextChanges.set(rel, null); continue }
          rescannedFiles++
          try {
            const abs = changedAbs.get(rel)!
            const text = await this.io.readText(abs, signal)
            signal.throwIfAborted()
            const after = await asyncFs.stat(abs)
            if (after.mtimeMs !== meta.mtime || after.size !== meta.size) throw new Error('changed during read')
            scannedBytes += meta.size
            batch.push({ text, rel, ext: extname(rel).toLowerCase() })
            batchBytes += meta.size
            if (batch.length >= 16 || batchBytes >= 1024 * 1024) await flush()
          } catch (e) {
            if (signal.aborted) throw signal.reason
            meta.pending = true
            contextChanges.set(rel, null)
            scanErrors.push(rel + ': ' + (e instanceof Error ? e.message : String(e)).slice(0, 200))
          }
        }
        await flush()
        // A target can appear/disappear without touching its importing file. Reconcile all
        // retained raw specifiers against the new file set, then use those exact edges everywhere.
        const indexedFiles = new Set(names)
        const firstImports = new Set<string>()
        for (let i = 0; i < imports.length; i++) {
          const edge = imports[i]
          const resolved = resolveSpecifier(this.root, edge.from, edge.specifier, indexedFiles)
          imports[i] = { ...edge, ...resolved, target: resolved.target }
          if (!symbolFiles.has(edge.from) && !firstImports.has(edge.from)) {
            firstImports.add(edge.from)
            contextChanges.set(edge.from, `${edge.from}:${edge.line} → ${resolved.to} — ${edge.context}`)
          }
          if (++visits % 1024 === 0) { await yieldImmediate(); signal.throwIfAborted() }
        }
        const graph = await getJobs().run<GraphState>('graph', { imports, files: names }, signal)
        candidate = { ...previous, files, symbols, imports, graph, updatedAt: Date.now() }
      }
      // A partial scan cannot advance the last successful reconciliation time.
      candidate = { ...candidate, verifiedAt: scanErrors.length === 0 ? Date.now() : previous.verifiedAt }
      let contexts = this.contexts
      if (!this.loaded) contexts = await this.buildContexts(candidate, signal)
      else {
        // Metadata-only changes and edits that preserve the first context do not rebuild the map.
        const updates = [...contextChanges].filter(([file, value]) => (contexts.get(file) ?? null) !== value)
        if (updates.length) {
          contexts = new Map(contexts)
          for (const [file, value] of updates) {
            if (value === null) contexts.delete(file); else contexts.set(file, value)
          }
          this.diagnostics.contextBuilds++
          this.diagnostics.contextRowsVisited += updates.length
        }
      }
      const report: ScanReport = {
        scannedBytes, rescannedFiles, addedFiles, droppedFiles, totalFiles: names.length,
        symbols: candidate.symbols.length, imports: candidate.imports.length,
        failedFiles: scanErrors.length, scanErrors,
      }
      // Retry a failed full save even on a clean scan. Otherwise keep the clean-tick fast path.
      await this.save(candidate, dirty || this.cacheWriteError ? getJobs() : undefined, signal)
      signal.throwIfAborted()
      this.state = candidate
      this.contexts = contexts
      this.loaded = true
      this.lastReport = report
      this.appendHistory(report)
      return report
    } finally {
      if (jobs) { await jobs.close(); this.diagnostics.activeWorkers-- }
    }
  }

  /* ────────────────────────── Part D：heal 时间序列 ────────────────────────── */

  /** append-only 写入一行；写失败静默；超限（行数 / 1MB）删最旧行保留尾部（engramory cap hook 思路） */
  private appendHistory(report: ScanReport): void {
    try {
      mkdirSync(dirname(this.historyFile), { recursive: true })
      const row: HealRow = { ts: Date.now(), root: this.root, ...report }
      appendFileSync(this.historyFile, JSON.stringify(row) + '\n', 'utf8')
      this.trimHistory()
    } catch {
      /* 写失败静默 */
    }
  }

  private trimHistory(): void {
    try {
      if (!existsSync(this.historyFile)) return
      const lines = readFileSync(this.historyFile, 'utf8').split('\n').filter((l) => l.trim() !== '')
      const maxRows = Math.max(1, Math.floor(this.opts.historyMaxRows ?? 200))
      const MAX_BYTES = 1024 * 1024
      let keep = lines
      while (keep.length > maxRows || Buffer.byteLength(keep.join('\n'), 'utf8') > MAX_BYTES) {
        if (keep.length <= 1) break
        keep = keep.slice(1)
      }
      if (keep.length === lines.length) return
      const tmp = this.historyFile + '.tmp'
      writeFileSync(tmp, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8')
      renameSync(tmp, this.historyFile)
    } catch {
      /* 裁剪失败静默 */
    }
  }

  /** 顺序读 heal-history，按 root 过滤后返回最近 limit 行（时间序）；坏行计数 */
  readHistory(root?: string, limit?: number): { rows: HealRow[]; corruptLines: number } {
    const rows: HealRow[] = []
    let corruptLines = 0
    try {
      if (!existsSync(this.historyFile)) return { rows, corruptLines }
      const text = readFileSync(this.historyFile, 'utf8')
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const r = JSON.parse(t) as HealRow
          if (typeof r.ts !== 'number' || typeof r.root !== 'string' || typeof r.scannedBytes !== 'number' || typeof r.symbols !== 'number') {
            corruptLines++
            continue
          }
          rows.push(r)
        } catch {
          corruptLines++
        }
      }
    } catch {
      /* 读失败静默 */
    }
    const filtered = root ? rows.filter((r) => r.root === root) : rows
    const lim = Math.max(1, Math.floor(limit ?? 200))
    return { rows: filtered.slice(-lim), corruptLines }
  }

  /** 趋势：末行 vs 前一行 的各指标增量（<2 行时为 0） */
  historyTrend(rows: HealRow[]): { scannedBytesDelta: number; rescannedFilesDelta: number; addedDelta: number; droppedDelta: number; windowCount: number } {
    if (rows.length < 2) return { scannedBytesDelta: 0, rescannedFilesDelta: 0, addedDelta: 0, droppedDelta: 0, windowCount: rows.length }
    const last = rows[rows.length - 1]
    const prev = rows[rows.length - 2]
    return {
      scannedBytesDelta: last.scannedBytes - prev.scannedBytes,
      rescannedFilesDelta: last.rescannedFiles - prev.rescannedFiles,
      addedDelta: last.addedFiles - prev.addedFiles,
      droppedDelta: last.droppedFiles - prev.droppedFiles,
      windowCount: rows.length,
    }
  }

  findSymbols(
    name: string,
    kind?: string,
    ranking = false,
    /** aider repomap 思路（issue #2405）：会话已提及的文件路径集合，命中这些文件时排名提前（仅排序，不改命中集合） */
    boostFiles?: string[],
  ): { hits: SymbolHit[]; matchedFileBytes: number } {
    const q = name.toLowerCase()
    const syms = this.state.symbols.filter((s) => {
      if (!s.name.toLowerCase().includes(q) && !q.includes(s.name.toLowerCase())) return false
      if (kind && s.kind !== kind) return false
      return true
    })
    if (ranking) {
      // 匹配度优先（完整名 > 前缀 > 子串），组内按所在文件 PageRank 降序（并列排序键），
      // boost 集合（会话上下文已提及的文件）再提前一档，最后 file+line 兜底——不改变命中集合，只改顺序。
      const ranks = this.state.graph?.ranks ?? {}
      // boost 集合（会话上下文已提及的文件）：绝对路径 → relative、strip './'、大小写归一；
      // 规范化失败的项直接跳过（比符号表的 posix 小写键对不上就白 boost 了）
      let boost: Set<string> | null = null
      if (boostFiles && boostFiles.length) {
        boost = new Set<string>()
        for (const f of boostFiles) {
          const n = normalizeBoostPath(this.root, f)
          if (n) boost.add(n)
        }
        if (boost.size === 0) boost = null
      }
      syms.sort((a, b) => {
        const qa = matchQuality(a.name, q)
        const qb = matchQuality(b.name, q)
        if (qa !== qb) return qa - qb
        if (boost) {
          const ba = boost.has(a.file.toLowerCase()) ? 0 : 1
          const bb = boost.has(b.file.toLowerCase()) ? 0 : 1
          if (ba !== bb) return ba - bb
        }
        const ra = ranks[a.file] ?? 0
        const rb = ranks[b.file] ?? 0
        if (ra !== rb) return rb - ra
        return a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1
      })
    } else {
      // 旧行为（默认）：file+line 排序，ranking=false 输出与升级前逐字节一致
      syms.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
    }
    const matchedFiles = new Set(syms.map((s) => s.file))
    let matchedFileBytes = 0
    for (const f of matchedFiles) {
      const meta = this.state.files[f]
      if (meta) matchedFileBytes += meta.size
    }
    return { hits: syms, matchedFileBytes }
  }

  findImports(file: string, direction: 'out' | 'in'): ImportEdge[] {
    const absolute = resolve(this.root, file.replace(/\\/g, '/'))
    const relPath = relative(this.root, absolute)
    if (!relPath || relPath === '..' || relPath.startsWith('..' + sep) || isAbsolute(relPath)) return []
    const target = posixify(relPath)
    const all = this.state.imports
    if (direction === 'out') {
      return all.filter((e) => e.from === target)
    }
    return all.filter((e) => e.status === 'resolved' && e.target === target)
  }

  /** 图中心度（await ensure() 后可用；旧缓存自动失效重建） */
  get graph(): GraphState | null {
    return this.state.graph
  }

  /** 短上下文：该文件首个符号（零 IO，索引内已有） */
  private fileContext(file: string): string {
    this.diagnostics.contextLookups++
    return this.contexts.get(file) ?? '(no symbols/imports)'
  }

  /** 被引用 top 的全量排序结果（indegree 降序 → rank 降序 → file），工具层再切片/落盘 */
  findHotspots(): GraphRow[] {
    const g = this.state.graph
    if (!g) return []
    return Object.keys(g.indegree)
      .filter((f) => g.indegree[f] > 0)
      .map((f) => ({ file: f, indegree: g.indegree[f], rank: g.ranks[f] ?? 0, context: this.fileContext(f) }))
      .sort((a, b) => b.indegree - a.indegree || b.rank - a.rank || (a.file < b.file ? -1 : 1))
  }

  /** 孤立文件：in=0 且 out=0（含无符号文件，按 file 排序） */
  findOrphans(): GraphRow[] {
    const g = this.state.graph
    if (!g) return []
    return g.orphans
      .map((f) => ({ file: f, indegree: 0, rank: g.ranks[f] ?? 0, context: this.fileContext(f) }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  }

  listFiles(pattern?: string): Array<{ file: string; lines: number; size: number }> {
    const pat = (pattern || '').toLowerCase()
    const out = Object.entries(this.state.files)
      .filter(([rel]) => !pat || rel.toLowerCase().includes(pat))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, meta]) => ({ file, lines: 0, size: meta.size }))
    return out
  }

  /** 超量落盘；写失败返回 null（调用方降级为只返回内联 top-N，不影响查询本身） */
  writeSpill(rows: unknown[], cacheDir: string, kind: string): { path: string; count: number } | null {
    return writeSpill(rows, cacheDir, kind)
  }

  resolveFile(file: string): string {
    if (isAbsolute(file)) return file
    return resolve(this.root, file)
  }
}

export function writeSpill(rows: unknown[], cacheDir: string, kind: string): { path: string; count: number } | null {
  try {
    const dir = join(cacheDir, 'spill')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8')
    return { path: file, count: rows.length }
  } catch { return null }
}

export { sliceRead, regexFirstMatch } from './slice.js'
export type { SliceResult, SliceRequest } from './slice.js'

export { scanJsonKeys, JSON_LIMITS, JSON_SCANNER_VERSION } from './json.js'
export type { JsonScanResult, JsonScanOptions, JsonEntry } from './json.js'
