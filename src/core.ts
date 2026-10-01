/**
 * dsh-project-index core
 * ----------------------
 * 增量项目索引：文件树 + 轻量符号表 + import 边，按 mtime/size 自愈（从磁盘真值重建，
 * 不信任过期缓存）；外加"指针式"字节切片读取，用于单行超大文件的低成本精读。
 *
 * 设计对齐 DSH 的 token 经济：查询只返回 路径/行号/短上下文 的指针，不整文件喂给模型。
 */
import {
  readdirSync, readFileSync, statSync, existsSync, mkdirSync,
  writeFileSync, renameSync, openSync, readSync, closeSync, fstatSync, appendFileSync, unlinkSync,
} from 'node:fs'
import {
  join, resolve, relative, sep, extname, dirname, isAbsolute,
} from 'node:path'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'

/* ────────────────────────── 类型 ────────────────────────── */

export interface FileMeta {
  /** ms-resolution mtime；索引自愈的指纹之一 */
  mtime: number
  size: number
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
 * 索引持久化形态（v6）：SymbolHit.file → fileIds[] 整数引用。
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
  /** 解析后的相对路径（若在 root 内）；否则保留原始 specifier */
  to: string
  line: number
  context: string
}

export interface IndexState {
  version: number
  root: string
  updatedAt: number
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

export interface SliceResult {
  path: string
  byteOffset: number
  lengthBytes: number
  totalBytes: number
  snippet: string
  nextByteOffset: number
  hitByteOffset?: number
  /** Part C：mode='tail' 时窗口起始字节偏移（=max(0, total-lengthBytes)） */
  tailOffset?: number
  mayTruncate: boolean
}

const VERSION = 6

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
  const nodes = allFiles && allFiles.length > 0
    ? [...allFiles]
    : [...new Set([...imports.map((e) => e.from), ...imports.map((e) => e.to)])]
  const nodeSet = new Set(nodes)
  // to 可能是无扩展的相对 specifier（如 './math_utils' → 'math_utils'），
  // 解析到节点集内实际文件（仅图内使用；不改变存储的 import 边与 out/in 查询输出）。
  //
  // 预建「无扩展前缀 → 首个匹配文件」索引，把解析从 O(nodes) 降到 O(1)。
  // 旧实现是 `for (const f of nodes) if (f.startsWith(t + '.'))` 的线性全扫：
  // 对每条未能直接命中的 specifier（外部包名如 'react' / 'node:fs' 永远命不中）
  // 都要扫完整个 nodes，且每轮新建 `t + '.'` 字符串。本仓库 19327 个节点 ×
  // 38869 条导入边 ≈ 数亿次比较，会在主线程上同步烧掉数分钟，把整个 DSH
  // （HTTP / RPC / 全部插件）一起冻住 —— 这就是 project_* 工具卡死宿主的原因。
  // 语义与旧实现一致：同一 key 取 nodes 顺序中首个匹配的文件。
  const strippedIndex = new Map<string, string>()
  for (const f of nodes) {
    let i = f.indexOf('.')
    while (i !== -1) {
      if (i > 0) {
        const key = f.slice(0, i)
        if (!strippedIndex.has(key)) strippedIndex.set(key, f)
      }
      i = f.indexOf('.', i + 1)
    }
  }
  const resolveNode = (t: string): string | undefined => {
    if (nodeSet.has(t)) return t
    return strippedIndex.get(t)
  }
  const indegree = new Map<string, number>(nodes.map((n) => [n, 0]))
  const outDeg = new Map<string, number>(nodes.map((n) => [n, 0]))
  const edges: Array<{ from: string; to: string }> = []
  for (const e of imports) {
    const to = resolveNode(e.to)
    if (!nodeSet.has(e.from) || !to) continue
    edges.push({ from: e.from, to })
    indegree.set(to, indegree.get(to)! + 1)
    outDeg.set(e.from, outDeg.get(e.from)! + 1)
  }
  const orphans = nodes.filter((n) => indegree.get(n) === 0 && outDeg.get(n) === 0).sort()
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
    { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm },
    { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|\:)/gm },
    { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm },
    { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
  ]
}

const PY_STYLE = new Set(['.py'])
const GO_STYLE = new Set(['.go'])
const RS_STYLE = new Set(['.rs'])

function patternsFor(ext: string): Pattern[] {
  if (JS_STYLE.has(ext)) return jsPatterns()
  if (PY_STYLE.has(ext)) {
    return [
      { kind: 'function', re: /^\s*(?:async\s+)?def\s+(\w+)/gm },
      { kind: 'class', re: /^\s*class\s+(\w+)/gm },
    ]
  }
  if (GO_STYLE.has(ext)) {
    return [
      { kind: 'func', re: /^\s*func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
      { kind: 'type', re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm },
    ]
  }
  if (RS_STYLE.has(ext)) {
    return [
      { kind: 'fn', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm },
      { kind: 'type', re: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/gm },
    ]
  }
  return [
    { kind: 'function', re: /^\s*(?:export\s+|public\s+|private\s+|protected\s+)?(?:static\s+|async\s+)?(?:function|def|fn)\s+([A-Za-z_]\w*)/gm },
    { kind: 'class', re: /^\s*(?:export\s+|public\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/gm },
  ]
}

function extractSymbols(text: string, ext: string, maxContextLen: number): Omit<SymbolHit, 'file'>[] {
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
      const line = lineOf(m.index)
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

function resolveSpecifier(root: string, fromFile: string, spec: string): string {
  const s = spec.trim()
  if (s.startsWith('.') || s.startsWith('/')) {
    const abs = resolve(dirname(join(root, fromFile)), s)
    const rel = relative(root, abs)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return posixify(rel)
  }
  return s
}

function extractImports(text: string, root: string, file: string, ext: string, maxContextLen: number): Omit<ImportEdge, 'from'>[] {
  const out: Omit<ImportEdge, 'from'>[] = []
  const seen = new Set<string>()
  // 与 extractSymbols 同一套行号查找表（旧实现每个匹配 O(text) 重切前缀）
  const lineOf = makeLineLookup(text)
  const ctx = (i: number): string => text.slice(text.lastIndexOf('\n', i - 1) + 1, text.indexOf('\n', i)).trim().slice(0, maxContextLen)

  if (JS_STYLE.has(ext)) {
    const res: [RegExp, number][] = [
      [/^\s*import\s+(?:[\w*{},\s\n/]+\s+from\s+)?['"]([^'"]+)['"]/gm, 1],
      [/^\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, 1],
      [/^\s*(?:const\s+[\w$]+\s*=\s*)?require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, 1],
    ]
    for (const [re] of res) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const spec = (m[1] || '').trim()
        if (!spec) continue
        const line = lineOf(m.index)
        const to = resolveSpecifier(root, file, spec)
        const key = to + '|' + line
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ to, line, context: ctx(m.index) })
      }
    }
  } else if (PY_STYLE.has(ext)) {
    const res: [RegExp][] = [
      [/^\s*from\s+(\S+)\s+import\b/gm],
      [/^\s*import\s+(\S+)/gm],
    ]
    for (const [re] of res) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const spec = (m[1] || '').trim()
        if (!spec) continue
        const to = spec.replace(/\./g, '/').split(':')[0]
        const line = lineOf(m.index)
        const key = to + '|' + line
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ to, line, context: ctx(m.index) })
      }
    }
  }
  return out
}

/* ────────────────────────── 文件树遍历 ────────────────────────── */

function* walkFiles(
  root: string,
  skipDirs: Set<string>,
  includeExts: Set<string>,
): Generator<{ rel: string; abs: string; mtime: number; size: number }> {
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue
        stack.push(abs)
      } else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase()
        if (!includeExts.has(ext)) continue
        try {
          const st = statSync(abs)
          yield { rel: posixify(relative(root, abs)), abs, mtime: st.mtimeMs, size: st.size }
        } catch {
          /* 并发删除等，忽略 */
        }
      }
    }
  }
}

/* ────────────────────────── 索引器 ────────────────────────── */

function emptyState(root: string): IndexState {
  return { version: VERSION, root: resolve(root), updatedAt: 0, files: {}, symbols: [], imports: [], graph: null }
}

function groupSymbolsByFile(symbols: SymbolHit[]): Map<string, SymbolHit[]> {
  const m = new Map<string, SymbolHit[]>()
  for (const s of symbols) {
    const a = m.get(s.file)
    if (a) a.push(s)
    else m.set(s.file, [s])
  }
  return m
}

function groupImportsByFile(imports: ImportEdge[]): Map<string, ImportEdge[]> {
  const m = new Map<string, ImportEdge[]>()
  for (const e of imports) {
    const a = m.get(e.from)
    if (a) a.push(e)
    else m.set(e.from, [e])
  }
  return m
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

export class ProjectIndexer {
  readonly root: string
  readonly cacheFile: string
  /** Part D：heal-history 文件（多 root 共享，行内带 root） */
  readonly historyFile: string
  /** Part D：本进程内 cacheFile 解析失败次数（自愈重建的次数提示） */
  cacheCorruptCount = 0
  private readonly opts: IndexOptions
  private state: IndexState
  lastReport: ScanReport | null = null

  constructor(root: string, cacheDir: string, opts: IndexOptions) {
    this.root = cwdAbs(root)
    this.cacheFile = join(cacheDir, 'index-' + rootHash(this.root) + '.json')
    this.historyFile = join(cacheDir, 'heal-history.jsonl')
    this.opts = opts
    this.state = this.load()
    if (this.state.root !== this.root) this.state = emptyState(this.root)
  }

  private load(): IndexState {
    let raw: unknown
    try {
      if (!existsSync(this.cacheFile)) return emptyState(this.root)
      raw = JSON.parse(readFileSync(this.cacheFile, 'utf8'))
    } catch {
      // 解析失败 = 缓存损坏（自愈重建，计数提示）
      this.cacheCorruptCount++
      return emptyState(this.root)
    }
    const s = raw as PersistedIndexState
    if (!s || typeof s !== 'object' || typeof s.root !== 'string' || s.version !== VERSION) {
      // version 不符 = 自然失效（不算损坏）；形状非法 = 损坏
      if (s && typeof s === 'object' && typeof (s as unknown as IndexState).root !== 'string') this.cacheCorruptCount++
      return emptyState(this.root)
    }
    // v6 持久化形态：SymbolRow{n,f,l,k,c} + fileList → 展开回 SymbolHit.file（内存态不变）
    if (Array.isArray(s.fileList) && Array.isArray(s.symbols) && s.symbols.length > 0 && typeof (s.symbols[0] as SymbolRow).f === 'number') {
      // 自愈守卫（P1-1）：一行 null/缺字段的坏数据不允许在构造函数里 throw——否则 indexers
      // Map 不缓存失败实例，该 root 的全部工具永久不可用，坏文件也永远无法被下次 save 重写。
      try {
        const fileList: string[] = s.fileList
        // f 越界（保存端旧版本折叠 / 手改）的行直接丢弃，不做静默改写
        const symbols: SymbolHit[] = s.symbols
          .filter((r) => r && typeof r.f === 'number' && Number.isSafeInteger(r.f) && r.f >= 0 && r.f < fileList.length)
          .map((r) => ({ name: r.n, file: fileList[r.f], line: r.l, kind: r.k, context: r.c }))
        return { version: s.version, root: s.root, updatedAt: s.updatedAt, files: s.files, symbols, imports: s.imports ?? [], graph: s.graph ?? null }
      } catch {
        // 展开失败 = 缓存损坏（自愈重建，计数提示；与 JSON.parse 分支同款）
        this.cacheCorruptCount++
        return emptyState(this.root)
      }
    }
    return s as unknown as IndexState
  }

  private save(): void {
    const tmp = this.cacheFile + '.tmp'
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      // v6 持久化：file 字符串 → files 表整数 id（226k 符号重复路径占 67% 体积 → -39%）
      const fileList: string[] = Object.keys(this.state.files)
      const fileId = new Map<string, number>()
      for (let i = 0; i < fileList.length; i++) fileId.set(fileList[i], i)
      const persisted: PersistedIndexState = {
        version: this.state.version,
        root: this.state.root,
        updatedAt: this.state.updatedAt,
        files: this.state.files,
        fileList,
        // 孤儿符号（file 不在 files 表：文件已从文件树消失）映射为 null 后过滤丢弃——
        // 绝不折叠到下标 0（旧写法 `?? 0` 会把指针改写成 files[0] 的真实文件名，说谎且写入持久层）。
        // 那些文件已不在文件树里，丢弃即诚实。
        symbols: this.state.symbols
          .map((s) => {
            const id = fileId.get(s.file)
            return id === undefined ? null : { n: s.name, f: id, l: s.line, k: s.kind, c: s.context }
          })
          .filter((r): r is SymbolRow => r !== null),
        imports: this.state.imports,
        graph: this.state.graph,
      }
      writeFileSync(tmp, JSON.stringify(persisted), 'utf8')
      renameSync(tmp, this.cacheFile)
    } catch {
      // 写缓存失败不应导致查询失败；顺手清掉可能残留的半截 .tmp（吞错）
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* 清理失败也静默 */
      }
    }
  }

  get status(): { root: string; files: number; symbols: number; imports: number; updatedAt: number } {
    return {
      root: this.state.root,
      files: Object.keys(this.state.files).length,
      symbols: this.state.symbols.length,
      imports: this.state.imports.length,
      updatedAt: this.state.updatedAt,
    }
  }

  /**
   * 增量刷新：只重扫 mtime/size 变化的文件，未变文件直接从上一代内存表继承条目。
   * 从"磁盘真值"重建派生状态——这是 mtime 自愈的核心，不依赖过期缓存。
   *
   * 两段式（P1-2）：第一段只 walk 文件树建文件表并判 dirty；clean tick 直接返回本次
   * walk 的文件数（其余指标归零），完全跳过符号分组（22 万符号）与 buildGraph
   * （19k 节点 PageRank）——每 5 分钟一次的 daemon clean tick 不再全量照跑阻塞主线程。
   */
  ensure(): ScanReport {
    if (!existsSync(this.root)) {
      throw new Error('root 不存在: ' + this.root)
    }
    const skip = new Set(this.opts.skipDirs)
    const exts = new Set(this.opts.includeExts.map((e) => (e.startsWith('.') ? e.toLowerCase() : '.' + e.toLowerCase())))

    /* 第一段：walk 文件树，只建文件表 + 收集需要重扫的文件（不分组、不抽符号、不建图） */
    const files: Record<string, FileMeta> = {}
    const changedAbs = new Map<string, string>() // rel → abs（本代 mtime/size 与上一代不同，需重扫）
    let totalFiles = 0
    let addedFiles = 0
    for (const f of walkFiles(this.root, skip, exts)) {
      totalFiles++
      files[f.rel] = { mtime: f.mtime, size: f.size }
      const prev = this.state.files[f.rel]
      // 判改：mtime/size 任一不同即脏；末位 f.mtime >= prev.mtime 是显式的 mtime 回退守卫
      //（目录替换/归档回灌时 mtime 可能倒退）——宁可多扫也不把回退当未变，并把门槛写明防止后续重构漏掉。
      if (prev && prev.mtime === f.mtime && prev.size === f.size && f.mtime >= prev.mtime) continue
      if (!prev) addedFiles++
      changedAbs.set(f.rel, f.abs)
    }
    // droppedFiles 语义修正（P2 前置）：绝对删除数 = 上一代有而本代无的文件数（≥0），
    // 不再是「上一代−本代」的净差（净差可为负，与字段名「删除数」矛盾，heal-history 里全是 -1）。
    // 注意：heal-history 新旧行语义在此分界（旧行负值是净差、新行是绝对数）；history 是滚动 200 行
    // 的运维数据，可接受。trend 的 droppedDelta 仍保留 last−prev 的差值语义。
    const nextRels = new Set(Object.keys(files))
    let droppedFiles = 0
    for (const rel of Object.keys(this.state.files)) {
      if (!nextRels.has(rel)) droppedFiles++
    }
    const dirty = droppedFiles !== 0 || addedFiles !== 0 || changedAbs.size !== 0

    /* clean tick 快路径：跳过分组 / buildGraph / save */
    if (!dirty) {
      this.lastReport = {
        scannedBytes: 0,
        rescannedFiles: 0,
        addedFiles: 0,
        droppedFiles: 0,
        totalFiles,
        symbols: this.state.symbols.length,
        imports: this.state.imports.length,
      }
      // Part D：clean tick 也追加一行 history（与旧行为一致：每次 ensure 都记账）
      this.appendHistory(this.lastReport)
      return this.lastReport
    }

    /* 第二段（仅 dirty）：重扫脏文件，未变文件直接继承上一代，重建派生状态 */
    const prevSyms = groupSymbolsByFile(this.state.symbols)
    const prevImps = groupImportsByFile(this.state.imports)
    const symbols: SymbolHit[] = []
    const imports: ImportEdge[] = []
    let scannedBytes = 0
    let rescannedFiles = 0

    for (const [rel, meta] of Object.entries(files)) {
      if (!changedAbs.has(rel)) {
        // 未变：直接继承上一代
        const s = prevSyms.get(rel)
        if (s) symbols.push(...s)
        const i = prevImps.get(rel)
        if (i) imports.push(...i)
        continue
      }
      if (meta.size > this.opts.maxScanBytes) continue // 只记文件树，token 上不抽超大文件
      rescannedFiles++
      let text: string
      try {
        text = readFileSync(changedAbs.get(rel)!, 'utf8')
      } catch {
        continue
      }
      scannedBytes += meta.size
      const syms = extractSymbols(text, extname(rel).toLowerCase(), this.opts.maxContextLen)
      for (const s of syms) symbols.push({ ...s, file: rel })
      const imps = extractImports(text, this.root, rel, extname(rel).toLowerCase(), this.opts.maxContextLen)
      for (const i of imps) imports.push({ ...i, from: rel })
    }

    // Part B：import 图上算入度 / PageRank / 孤立文件（全节点集 = 本代文件表）
    const graph = buildGraph(imports, Object.keys(files))
    // 脏判定已在第一段完成（dropped/added/changed 任一非零）；此处不再重复计算。
    this.state = {
      ...this.state,
      updatedAt: Date.now(),
      files,
      symbols,
      imports,
      graph: {
        indegree: Object.fromEntries(graph.indegree),
        ranks: Object.fromEntries(graph.ranks),
        orphans: graph.orphans,
      },
    }
    this.lastReport = {
      scannedBytes,
      rescannedFiles,
      addedFiles,
      droppedFiles,
      totalFiles,
      symbols: symbols.length,
      imports: imports.length,
    }
    if (dirty) this.save()
    // Part D：同 tick 内（不另开定时器）把本次 heal 追加为结构化时间序列
    this.appendHistory(this.lastReport)
    return this.lastReport
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
    const target = posixify(file)
    const all = this.state.imports
    if (direction === 'out') {
      return all.filter((e) => e.from === target || e.from === file)
    }
    return all.filter((e) => e.to === target || e.to === file || e.to.replace(/\//g, '\\') === file)
  }

  /** Part B：图中心度（ensure 后可用；旧缓存 version=4 会在 load 时失效重建） */
  get graph(): GraphState | null {
    return this.state.graph
  }

  /** 短上下文：该文件首个符号（零 IO，索引内已有） */
  private fileContext(file: string): string {
    const s = this.state.symbols.find((x) => x.file === file)
    if (s) return `${s.file}:${s.line} (${s.kind}) ${s.name} — ${s.context}`
    const e = this.state.imports.find((x) => x.from === file)
    if (e) return `${e.from}:${e.line} → ${e.to} — ${e.context}`
    return '(no symbols/imports)'
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
    try {
      const dir = join(cacheDir, 'spill')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8')
      return { path: file, count: rows.length }
    } catch {
      return null
    }
  }

  resolveFile(file: string): string {
    if (isAbsolute(file)) return file
    return resolve(this.root, file)
  }
}

/* ────────────────────────── 指针式字节切片 ────────────────────────── */

/**
 * 精确读一段文件字节窗（不整读文件），返回 字节偏移/snippet/next 指针。
 * 对"单行超大文件"特别友好：行号读取会失效，字节游标不会。
 *
 * Part C 增强（默认行为不变）：
 *  - `mode:'tail'`：从文件尾部读 lengthBytes 窗口（日志场景），返回值带 `tailOffset`；
 *    默认 `window` 行为（startBytes/find 定位）不变。
 *  - `re:true`：find 按正则（大小写不敏感）查找；默认字面量子串（现行为，逐字节不变）。
 *    ReDoS 防护：find.length ≤ 256；正则在独立线程执行，超预算（250ms）terminate 抛错。
 */
export async function sliceRead(
  absPath: string,
  request: {
    startBytes?: number
    lengthBytes?: number
    find?: string
    findFrom?: number
    contextBefore?: number
    mode?: 'window' | 'tail'
    re?: boolean
  },
): Promise<SliceResult> {
  const fd = openSync(absPath, 'r')
  try {
    const total = fstatSync(fd).size
    const length = Math.min(Math.floor(request.lengthBytes ?? 4096), 16 * 1024 * 1024)
    let offset = Math.max(0, Math.floor(request.startBytes ?? 0))
    let tailOffset: number | undefined
    let hitByteOffset: number | undefined

    if (request.mode === 'tail') {
      // tail：从尾部读一个窗口（日志场景），find 不适用
      offset = Math.max(0, total - length)
      tailOffset = offset
    } else if (request.find) {
      if (request.re) {
        // 正则 find（默认关，re:true 才开）：长度上限 256；exec 在独立线程执行并有界中断
        //（默认 250ms，超时抛 slice_find_regex_timeout）——回溯炸弹不再阻塞主线程
        const pattern = request.find
        if (pattern.length > 256) throw new Error('slice_find_regex_too_long')
        const re = new RegExp(pattern, 'i')
        const from = Math.max(0, Math.floor(request.findFrom ?? 0))
        const CHUNK = 64 * 1024
        let pos = from
        while (pos < total) {
          const len = Math.min(CHUNK, total - pos)
          const buf = Buffer.allocUnsafe(len)
          const n = readSync(fd, buf, 0, len, pos)
          const text = buf.subarray(0, n).toString('utf8')
          const idx = await regexFirstMatch(text, re)
          if (idx !== null) {
            const prefix = text.slice(0, idx)
            hitByteOffset = pos + Buffer.byteLength(prefix, 'utf8')
            break
          }
          pos += n
        }
        if (hitByteOffset === undefined) {
          throw new Error(`slice_find 未命中 "${request.find}"（re=true，从 byte ${from} 起）`)
        }
        offset = Math.max(0, hitByteOffset - Math.floor(request.contextBefore ?? 256))
      } else {
        // 字面量子串（默认，大小写不敏感）——升级前行为，逐字节不变
        const needle = request.find.toLowerCase()
        const from = Math.max(0, Math.floor(request.findFrom ?? 0))
        const CHUNK = 64 * 1024
        let pos = from
        outer: while (pos < total) {
          const len = Math.min(CHUNK, total - pos)
          const buf = Buffer.allocUnsafe(len)
          const n = readSync(fd, buf, 0, len, pos)
          const text = buf.subarray(0, n).toString('utf8')
          const idx = text.toLowerCase().indexOf(needle)
          if (idx >= 0) {
            const prefix = text.slice(0, idx)
            hitByteOffset = pos + Buffer.byteLength(prefix, 'utf8')
            break outer
          }
          pos += n
        }
        if (hitByteOffset === undefined) {
          throw new Error(`slice_find 未命中 "${request.find}"（从 byte ${from} 起）`)
        }
        offset = Math.max(0, hitByteOffset - Math.floor(request.contextBefore ?? 256))
      }
    }

    const buf = Buffer.allocUnsafe(length)
    const n = offset >= total ? 0 : readSync(fd, buf, 0, Math.min(length, total - offset), offset)
    let snippet = buf.subarray(0, n).toString('utf8')
    // 新行读少量余量，便于模型上下文对齐（仍是固定窗口，不无界膨胀）
    const EXTRA = 256
    if (n >= length) {
      const more = Buffer.allocUnsafe(EXTRA)
      const m = total - (offset + n)
      if (m > 0) {
        const r = readSync(fd, more, 0, Math.min(EXTRA, m), offset + n)
        snippet += more.subarray(0, r).toString('utf8')
      }
    }
    return {
      path: absPath,
      byteOffset: offset,
      lengthBytes: n,
      totalBytes: total,
      snippet,
      nextByteOffset: offset + n,
      hitByteOffset,
      tailOffset,
      mayTruncate: n < length,
    }
  } finally {
    closeSync(fd)
  }
}

/* ────────────────────────── 正则 find 的 ReDoS 防护（Part C）────────────────────────── */

/**
 * 在单块文本上跑一次正则，返回首个匹配的字符下标；超预算抛 `slice_find_regex_timeout`。
 *
 * 真防护（P0-1）：JS 正则的 exec 无法在主线程中断——旧实现的"墙钟预算"检查在 exec
 * 返回之后才执行，`(a+)+$` 这类回溯炸弹照样把主线程阻塞上百秒。这里把 exec 挪进
 * worker_threads（eval 模式、自包含代码字符串，不引用任何插件相对路径，打包/安装目录
 * 无关），主线程 setTimeout 超预算即 worker.terminate()，实现有界中断。
 *
 * 预算默认 250ms：10ms 连 worker 启动都覆盖不了（V8 isolate 冷启动 ~30-80ms），
 * sliceRead 的 request 结构没有可透传的 options 槽位，故以常量 + 本注释固定。
 */
const REGEX_BUDGET_MS = 250

export async function regexFirstMatch(text: string, re: RegExp, budgetMs = REGEX_BUDGET_MS): Promise<number | null> {
  // eval 模式自包含 worker：workerData 只传 source/flags/text，代码里不碰 fs/相对路径
  const workerSrc = `
    const { workerData, parentPort } = require('node:worker_threads');
    try {
      const m = new RegExp(workerData.source, workerData.flags).exec(workerData.text);
      parentPort.postMessage(m ? m.index : null);
    } catch {
      parentPort.postMessage(null);
    }
  `
  return new Promise<number | null>((resolveP, rejectP) => {
    let worker: Worker
    try {
      worker = new Worker(workerSrc, {
        eval: true,
        workerData: { source: re.source, flags: re.flags, text },
      })
    } catch {
      // worker 创建失败也不能退回同步 exec（那等于没有防护）——按超时失败
      rejectP(new Error('slice_find_regex_timeout'))
      return
    }
    const timer = setTimeout(() => {
      try {
        worker.terminate()
      } catch {
        /* terminate 失败忽略 */
      }
      rejectP(new Error('slice_find_regex_timeout'))
    }, Math.max(1, Math.floor(budgetMs)))
    worker.on('message', (idx: unknown) => {
      clearTimeout(timer)
      void worker.terminate()
      resolveP(typeof idx === 'number' ? idx : null)
    })
    worker.on('error', () => {
      clearTimeout(timer)
      rejectP(new Error('slice_find_regex_timeout'))
    })
    worker.on('exit', (code) => {
      clearTimeout(timer)
      // 正常路径 message 已 resolve；走到这里说明没 postMessage 就退了
      if (code !== 0) rejectP(new Error('slice_find_regex_timeout'))
    })
  }).catch(() => {
    // 收口：任何 worker 异常（创建/exec/退出）统一按超时失败，绝不退回同步 exec
    throw new Error('slice_find_regex_timeout')
  })
}

/* ────────────────────────── 有界 JSON 顶层键扫描（Part C）────────────────────────── */

export interface JsonEntry {
  key: string
  /** 值起始字节（冒号后第一个非空白字符） */
  byteStart: number
  /** 值结束字节（独占，配合 project_slice_read 回跳精读） */
  byteEnd: number
  /** 值摘要（≤ maxPreview 字符，超长截断加 …） */
  preview: string
}

export interface JsonScanResult {
  topLevel: 'object' | 'array' | 'primitive' | 'error'
  error?: string
  /** 顶层键总数（流式扫出，即使分页/落盘也完整） */
  totalKeys: number
  entries: JsonEntry[]
  /** 非 object 时的头部诊断预览 */
  topPreview: string
}

/**
 * 有界 JSON 顶层键扫描：不 `JSON.parse` 整文件，按 64KB 块流式扫描顶层 `{...}` 的
 * key → byteStart/byteEnd + ≤maxPreview 字符的值摘要。单行 10MB JSON 不 OOM（值只跳过不驻留）。
 * 只读文件，遵循既有 fs-sandbox 策略（openSync 'r'）。
 */
export function scanJsonKeys(absPath: string, opts: { maxPreview?: number } = {}): JsonScanResult {
  const maxPreview = Math.max(16, Math.floor(opts.maxPreview ?? 240))
  const fd = openSync(absPath, 'r')
  try {
    const total = fstatSync(fd).size
    const CHUNK = 64 * 1024
    let readPos = 0
    let buf = Buffer.alloc(0)
    let bi = 0
    /** 读下一个字节（返回其字符与绝对字节偏移）；EOF 返回 null */
    const next = (): { ch: string; off: number } | null => {
      if (bi >= buf.length) {
        if (readPos >= total) return null
        const len = Math.min(CHUNK, total - readPos)
        const nb = Buffer.allocUnsafe(len)
        const n = readSync(fd, nb, 0, len, readPos)
        if (n <= 0) return null
        buf = nb.subarray(0, n)
        bi = 0
        readPos += n
      }
      const off = readPos - buf.length + bi
      const ch = String.fromCharCode(buf[bi])
      bi++
      return { ch, off }
    }
    const nextNonWs = (): { ch: string; off: number } | null => {
      let c = next()
      while (c && /\s/.test(c.ch)) c = next()
      return c
    }
    /** 跳过 JSON 字符串（当前已在开引号之后），返回结束引号后的字符 */
    const skipStringRaw = (): { ch: string; off: number } | null => {
      while (true) {
        const c = next()
        if (!c) return null
        if (c.ch === '\\') {
          if (!next()) return null
          continue
        }
        if (c.ch === '"') return next()
      }
    }
    /** 读 key 字符串原始字节（当前已在开引号之后），返回结束引号后的字符 */
    const readStringBytes = (bytes: number[]): { ch: string; off: number } | null => {
      while (true) {
        const c = next()
        if (!c) return null
        if (c.ch === '"') return next() // 未转义结束引号：不入字节
        bytes.push(c.ch.charCodeAt(0))
        if (c.ch === '\\') {
          const e = next()
          if (!e) return null
          bytes.push(e.ch.charCodeAt(0))
          if (e.ch === 'u') {
            for (let k = 0; k < 4; k++) {
              const h = next()
              if (!h) return null
              bytes.push(h.ch.charCodeAt(0))
            }
          }
        }
      }
    }
    /** 跳过嵌套对象/数组（当前已在 { 或 [ 之后），深度归零后返回其后的字符 */
    const skipNested = (): { ch: string; off: number } | null => {
      let depth = 1
      let c = next()
      while (c) {
        if (c.ch === '"') {
          c = skipStringRaw()
          continue
        }
        if (c.ch === '{' || c.ch === '[') depth++
        else if (c.ch === '}' || c.ch === ']') {
          depth--
          if (depth === 0) return next()
        }
        c = next()
      }
      return null
    }
    /** 跳过任意 JSON 值（first 为其首字符），返回值后的字符 */
    const skipValue = (first: { ch: string; off: number }): { ch: string; off: number } | null => {
      if (first.ch === '"') return skipStringRaw()
      if (first.ch === '{' || first.ch === '[') return skipNested()
      // 字面量：读到分隔符/空白
      let c: { ch: string; off: number } | null = first
      while (c && !/[,\]\}\s]/.test(c.ch)) c = next()
      return c
    }
    const readPreview = (byteStart: number, byteEnd: number): string => {
      const len = Math.min(maxPreview + 16, Math.max(0, byteEnd - byteStart))
      if (len <= 0) return ''
      const pbuf = Buffer.allocUnsafe(len)
      const pn = readSync(fd, pbuf, 0, len, byteStart)
      let text = pbuf.subarray(0, pn).toString('utf8')
      if (text.length > maxPreview) text = text.slice(0, maxPreview) + '…'
      return text
    }

    const first = nextNonWs()
    if (!first) return { topLevel: 'error', error: '空文件', totalKeys: 0, entries: [], topPreview: '' }
    if (first.ch !== '{') {
      const topLevel = first.ch === '[' ? 'array' : 'primitive'
      return {
        topLevel,
        error: `顶层不是对象（首字符 ${JSON.stringify(first.ch)}）`,
        totalKeys: 0,
        entries: [],
        topPreview: readPreview(first.off, total),
      }
    }

    // 顶层对象：逐 key 扫描（'{' 已消费）
    const entries: JsonEntry[] = []
    let error: string | undefined
    let c = nextNonWs()
    while (c) {
      if (c.ch === '}') break
      if (c.ch === ',') {
        c = nextNonWs()
        continue
      }
      if (c.ch === '"') {
        const keyBytes: number[] = []
        const afterKey = readStringBytes(keyBytes)
        if (!afterKey) {
          error = 'key 字符串未闭合'
          break
        }
        const keyName = decodeJsonKey(Buffer.from(keyBytes).toString('utf8'))
        let colon: { ch: string; off: number } | null = afterKey
        while (colon && /\s/.test(colon.ch)) colon = next()
        if (!colon || colon.ch !== ':') {
          error = '缺冒号'
          break
        }
        let v = next()
        while (v && /\s/.test(v.ch)) v = next()
        if (!v) {
          error = '值缺失'
          break
        }
        const byteStart = v.off
        const afterVal = skipValue(v)
        if (!afterVal) {
          error = `值未闭合 (key=${keyName})`
          break
        }
        const byteEnd = afterVal.off
        entries.push({ key: keyName, byteStart, byteEnd, preview: readPreview(byteStart, byteEnd) })
        c = nextNonWs()
        continue
      }
      error = `意外字符 ${JSON.stringify(c.ch)} @byte ${c.off}`
      break
    }
    return { topLevel: 'object', error, totalKeys: entries.length, entries, topPreview: '' }
  } finally {
    closeSync(fd)
  }
}

/** JSON key 字符串转义解码（\uXXXX 与短转义） */
function decodeJsonKey(raw: string): string {
  return raw.replace(/\\(?:u([0-9a-fA-F]{4})|["\\/bfnrt])/g, (m, hex?: string) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16))
    switch (m) {
      case '\\"': return '"'
      case '\\\\': return '\\'
      case '\\/': return '/'
      case '\\b': return '\b'
      case '\\f': return '\f'
      case '\\n': return '\n'
      case '\\r': return '\r'
      case '\\t': return '\t'
      default: return m
    }
  })
}
