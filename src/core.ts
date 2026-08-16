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
  writeFileSync, renameSync, openSync, readSync, closeSync, fstatSync,
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
}

export interface IndexOptions {
  includeExts: string[]
  skipDirs: string[]
  /** 符号/import 抽取只对 ≤ 该字节数的文件执行（超大文件只进文件树，不抽符号） */
  maxScanBytes: number
  maxContextLen: number
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

export interface SliceResult {
  path: string
  byteOffset: number
  lengthBytes: number
  totalBytes: number
  snippet: string
  nextByteOffset: number
  hitByteOffset?: number
  mayTruncate: boolean
}

const VERSION = 4

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
  return { version: VERSION, root: resolve(root), updatedAt: 0, files: {}, symbols: [], imports: [] }
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
  private readonly opts: IndexOptions
  private state: IndexState
  lastReport: ScanReport | null = null

  constructor(root: string, cacheDir: string, opts: IndexOptions) {
    this.root = cwdAbs(root)
    this.cacheFile = join(cacheDir, 'index-' + rootHash(this.root) + '.json')
    this.opts = opts
    this.state = this.load()
    if (this.state.root !== this.root) this.state = emptyState(this.root)
  }

  private load(): IndexState {
    try {
      if (!existsSync(this.cacheFile)) return emptyState(this.root)
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as IndexState
      if (!raw || raw.version !== VERSION || typeof raw.root !== 'string') return emptyState(this.root)
      return raw
    } catch {
      return emptyState(this.root)
    }
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
    this.state = {
      ...this.state,
      updatedAt: Date.now(),
      files,
      symbols,
      imports,
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
    return this.lastReport
  }

  findSymbols(name: string, kind?: string): { hits: SymbolHit[]; matchedFileBytes: number } {
    const q = name.toLowerCase()
    const syms = this.state.symbols.filter((s) => {
      if (!s.name.toLowerCase().includes(q) && !q.includes(s.name.toLowerCase())) return false
      if (kind && s.kind !== kind) return false
      return true
    })
    syms.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
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
 */
export function sliceRead(
  absPath: string,
  request: { startBytes?: number; lengthBytes?: number; find?: string; findFrom?: number; contextBefore?: number },
): SliceResult {
  const fd = openSync(absPath, 'r')
  try {
    const total = fstatSync(fd).size
    let offset = Math.max(0, Math.floor(request.startBytes ?? 0))
    let hitByteOffset: number | undefined

    if (request.find) {
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

    const length = Math.min(Math.floor(request.lengthBytes ?? 4096), 16 * 1024 * 1024)
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
      mayTruncate: n < length,
    }
  } finally {
    closeSync(fd)
  }
}
