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
  writeFileSync, renameSync, openSync, readSync, closeSync, fstatSync, appendFileSync,
} from 'node:fs'
import {
  join, resolve, relative, sep, extname, dirname, isAbsolute,
} from 'node:path'
import { createHash } from 'node:crypto'

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

const VERSION = 5

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
  const resolveNode = (t: string): string | undefined => {
    if (nodeSet.has(t)) return t
    for (const f of nodes) if (f.startsWith(t + '.')) return f
    return undefined
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
  for (const p of patternsFor(ext)) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(text)) !== null) {
      const name = m[1]
      if (!name) continue
      const line = text.slice(0, m.index).split('\n').length
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
  const lineAt = (i: number): number => text.slice(0, i).split('\n').length
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
        const line = lineAt(m.index)
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
        const line = lineAt(m.index)
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
    const s = raw as IndexState
    if (!s || typeof s !== 'object' || typeof s.root !== 'string' || s.version !== VERSION) {
      // version 不符 = 自然失效（不算损坏）；形状非法 = 损坏
      if (s && typeof s === 'object' && typeof (s as IndexState).root !== 'string') this.cacheCorruptCount++
      return emptyState(this.root)
    }
    return s
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      const tmp = this.cacheFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      renameSync(tmp, this.cacheFile)
    } catch {
      /* 写缓存失败不应导致查询失败 */
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
   */
  ensure(): ScanReport {
    if (!existsSync(this.root)) {
      throw new Error('root 不存在: ' + this.root)
    }
    const skip = new Set(this.opts.skipDirs)
    const exts = new Set(this.opts.includeExts.map((e) => (e.startsWith('.') ? e.toLowerCase() : '.' + e.toLowerCase())))
    const prevSyms = groupSymbolsByFile(this.state.symbols)
    const prevImps = groupImportsByFile(this.state.imports)

    const files: Record<string, FileMeta> = {}
    const symbols: SymbolHit[] = []
    const imports: ImportEdge[] = []
    let scannedBytes = 0
    let rescannedFiles = 0
    let addedFiles = 0
    let totalFiles = 0

    for (const f of walkFiles(this.root, skip, exts)) {
      totalFiles++
      files[f.rel] = { mtime: f.mtime, size: f.size }
      const prev = this.state.files[f.rel]
      if (prev && prev.mtime === f.mtime && prev.size === f.size) {
        // 未变：直接继承上一代
        const s = prevSyms.get(f.rel)
        if (s) symbols.push(...s)
        const i = prevImps.get(f.rel)
        if (i) imports.push(...i)
        continue
      }
      if (!prev) addedFiles++
      if (f.size > this.opts.maxScanBytes) continue // 只记文件树，token 上不抽超大文件
      rescannedFiles++
      let text: string
      try {
        text = readFileSync(f.abs, 'utf8')
      } catch {
        continue
      }
      scannedBytes += f.size
      const syms = extractSymbols(text, extname(f.abs).toLowerCase(), this.opts.maxContextLen)
      for (const s of syms) symbols.push({ ...s, file: f.rel })
      const imps = extractImports(text, this.root, f.rel, extname(f.abs).toLowerCase(), this.opts.maxContextLen)
      for (const i of imps) imports.push({ ...i, from: f.rel })
    }

    const droppedFiles = Object.keys(this.state.files).length - Object.keys(files).length
    // Part B：import 图上算入度 / PageRank / 孤立文件（全节点集 = 本代文件表）
    const graph = buildGraph(imports, Object.keys(files))
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
    this.save()
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

  findSymbols(name: string, kind?: string, ranking = false): { hits: SymbolHit[]; matchedFileBytes: number } {
    const q = name.toLowerCase()
    const syms = this.state.symbols.filter((s) => {
      if (!s.name.toLowerCase().includes(q) && !q.includes(s.name.toLowerCase())) return false
      if (kind && s.kind !== kind) return false
      return true
    })
    if (ranking) {
      // 匹配度优先（完整名 > 前缀 > 子串），组内按所在文件 PageRank 降序（并列排序键），
      // 再 file+line 兜底——不改变命中集合，只改顺序。
      const ranks = this.state.graph?.ranks ?? {}
      syms.sort((a, b) => {
        const qa = matchQuality(a.name, q)
        const qb = matchQuality(b.name, q)
        if (qa !== qb) return qa - qb
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

  writeSpill(rows: unknown[], cacheDir: string, kind: string): { path: string; count: number } {
    const dir = join(cacheDir, 'spill')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8')
    return { path: file, count: rows.length }
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
 *    ReDoS 防护：find.length ≤ 256；每 64KB 块内正则执行超 10ms 记失败抛错。
 */
export function sliceRead(
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
): SliceResult {
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
        // 正则 find（默认关，re:true 才开）：长度上限 256 + 单块 10ms 超时防 ReDoS
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
          const idx = regexFirstMatch(text, re, 10)
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
 * 在单块文本上跑一次正则，返回首个匹配的字符下标；超预算（默认 10ms）抛
 * `slice_find_regex_timeout`（"单块超时记失败"）。JS 正则无法真正中断，
 * 故用墙钟预算 + 64KB 分块把最坏回溯限制在单块内，超时即失败。
 * budgetMs 传负数可确定性触发超时（e2e 用）。
 */
export function regexFirstMatch(text: string, re: RegExp, budgetMs = 10): number | null {
  re.lastIndex = 0
  const t0 = Date.now()
  const m = re.exec(text)
  const elapsed = Date.now() - t0
  if (elapsed > budgetMs) throw new Error('slice_find_regex_timeout')
  return m ? m.index : null
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
