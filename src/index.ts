/**
 * @dsh-external/dsh-project-index
 * -------------------------------
 * hybrid 插件：toolkit（指针式项目阅读工具集）+ daemon-loop（后台 mtime 自愈索引）。
 *
 * 借鉴 DSH 的"token 经济"：
 *   - 查询只返回 路径/行号/短上下文 指针，超量落盘返回 spill 路径；
 *   - 索引按 mtime/size 增量自愈，不重读未变文件；
 *   - 提供 byte 级切片读取，应对"单行超大文件行号失效"的缝。
 * 后台循环只做文件系统自愈，不碰 LLM（守护也讲 token 经济）。
 */
import type { Context } from 'cordis'
import z from 'schemastery'
import { mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve, isAbsolute, relative } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  ProjectIndexer,
  sliceRead,
  cwdAbs,
  rootHash,
  estimateTokens,
  type IndexOptions,
} from './core.js'

type AppContext = Context & {
  setInterval(fn: () => void, ms: number): unknown
}

export const name = '@dsh-external/dsh-context-economy'
export const inject = ['tools']

const DEFAULT_EXTS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.php', '.rb', '.sh', '.md', '.json', '.yaml', '.yml',
].join(',')
const DEFAULT_SKIP = ['.git', 'node_modules', 'dist', 'out', 'build', 'coverage', '.next', '.venv', 'venv', 'target', '.dsh', '.cache'].join(',')

export interface Config {
  rootDir: string
  skipDirs: string
  includeExts: string
  maxScanBytes: number
  maxContextLen: number
  maxHits: number
  sliceBytes: number
  intervalMs: number
  logFile: string
  lowerNameOnly: boolean
}

export const Config = z.object({
  rootDir: z.string().default(''),
  skipDirs: z.string().default(DEFAULT_SKIP),
  includeExts: z.string().default(DEFAULT_EXTS),
  maxScanBytes: z.number().min(1024).max(16 * 1024 * 1024).default(512 * 1024),
  maxContextLen: z.number().min(40).max(2000).default(240),
  maxHits: z.number().min(1).max(2000).default(120),
  sliceBytes: z.number().min(256).max(16 * 1024 * 1024).default(4096),
  intervalMs: z.number().min(5000).max(86_400_000).default(300_000),
  logFile: z.string().default(''),
  lowerNameOnly: z.boolean().default(true),
})

const text = (s: string): ContentBlock[] => [{ type: 'text', text: s }]

export function apply(ctx: AppContext, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const cacheDir = join(dshHome, 'project-index')
  const logFile = config.logFile || join(dshHome, 'super-injector', 'dsh-project-index.log')
  const defaultRoot = config.rootDir ? cwdAbs(config.rootDir) : ''

  const opts: IndexOptions = {
    includeExts: config.includeExts.split(',').map((s) => s.trim()).filter(Boolean),
    skipDirs: config.skipDirs.split(',').map((s) => s.trim()).filter(Boolean),
    maxScanBytes: config.maxScanBytes,
    maxContextLen: config.maxContextLen,
  }

  const indexers = new Map<string, ProjectIndexer>()

  function log(msg: string): void {
    try {
      mkdirSync(join(dshHome, 'super-injector'), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {
      /* 日志失败静默 */
    }
  }

  function indexerFor(rootArg?: string): ProjectIndexer {
    const root = rootArg ? cwdAbs(rootArg) : defaultRoot
    if (!root) throw new Error('未配置 rootDir 且未传 root 参数；请在插件设置里填 rootDir 或每次传 root')
    let idx = indexers.get(root)
    if (!idx) {
      idx = new ProjectIndexer(root, cacheDir, opts)
      indexers.set(root, idx)
    }
    idx.ensure()
    return idx
  }

  const rel = (idx: ProjectIndexer, abs: string): string => {
    const r = relative(idx.root, abs)
    return r && !r.startsWith('..') && !isAbsolute(r) ? r.replace(/\\/g, '/') : abs
  }

  /* ────────── 工具 1：索引状态 ────────── */
  const toolStatus = defineTool({
    name: 'project_index_status',
    description: '查看/刷新某个根目录的增量项目索引状态（文件数、符号数、import 数、最近一次自愈扫描字节）。token 开销极低。',
    parameters: {
      root: { type: 'string', description: '项目根目录（相对插件 rootDir 时给绝对路径最稳）。缺省用 rootDir' },
      refresh: { type: 'boolean', description: '为 true 强制做一次 mtime 自愈扫描再返回' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          files: { type: 'integer' },
          symbols: { type: 'integer' },
          imports: { type: 'integer' },
          updatedAt: { type: 'integer' },
          scannedBytes: { type: 'integer' },
          rescannedFiles: { type: 'integer' },
          addedFiles: { type: 'integer' },
          droppedFiles: { type: 'integer' },
        },
      },
      render: (_args, v) => {
        const s = v as Record<string, number | string>
        return text([
          `[index] root=${s.root}`,
          `files=${s.files} symbols=${s.symbols} imports=${s.imports} updatedAt=${s.updatedAt}`,
          s.scannedBytes !== undefined ? `lastHeal: scannedBytes=${s.scannedBytes} rescanned=${s.rescannedFiles} added=${s.addedFiles} dropped=${s.droppedFiles}` : '',
        ].filter(Boolean).join('\n'))
      },
    },
    execute: async (args) => {
      const idx = indexerFor(args.root)
      if (args.refresh) idx.ensure()
      const rep = idx.lastReport
      return {
        root: idx.root,
        files: idx.status.files,
        symbols: idx.status.symbols,
        imports: idx.status.imports,
        updatedAt: idx.status.updatedAt,
        scannedBytes: rep?.scannedBytes ?? 0,
        rescannedFiles: rep?.rescannedFiles ?? 0,
        addedFiles: rep?.addedFiles ?? 0,
        droppedFiles: rep?.droppedFiles ?? 0,
      }
    },
  })

  /* ────────── 工具 2：符号查找（指针式，超量落盘） ────────── */
  const toolSymbols = defineTool({
    name: 'project_symbols_find',
    description: '在增量索引里按名字/子串查找函数、类、常量等符号，返回 相对路径+行号+短上下文 指针（不整文件喂给模型）。命中超 maxHits 的部分写入 spill 文件并返回其路径。',
    parameters: {
      root: { type: 'string', description: '项目根目录' },
      name: { type: 'string', description: '符号名或子串', required: true },
      kind: { type: 'string', description: '过滤 kind：function/class/const/type/interface/func/fn' },
      limit: { type: 'integer', description: '内联返回上限，缺省用 maxHits' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          query: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          matchedFileBytes: { type: 'integer' },
          spillPath: { type: 'string' },
          spillCount: { type: 'integer' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string' },
                file: { type: 'string' },
                line: { type: 'integer' },
                kind: { type: 'string' },
                context: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, v) => {
        const lines: string[] = [`[symbols] ${v.query} → ${v.total} hits, 输出 ${v.returned} 条`]
        for (const h of v.hits ?? []) lines.push(` ${h.file}:${h.line} (${h.kind}) ${h.name} — ${h.context}`)
        if (v.spillPath) lines.push(` [spill] 其余 ${v.spillCount} 条见 ${v.spillPath}`)
        lines.push(` [root] ${v.root}`)
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const idx = indexerFor(args.root)
      const { hits, matchedFileBytes } = idx.findSymbols(args.name, args.kind)
      const limit = Math.max(1, Math.floor(args.limit ?? config.maxHits))
      const kept = hits.slice(0, limit)
      let spillPath = ''
      let spillCount = 0
      if (hits.length > limit) {
        spillPath = idx.writeSpill(hits.slice(limit), cacheDir, 'symbols').path
        spillCount = hits.length - limit
      }
      return {
        root: idx.root,
        query: args.name,
        total: hits.length,
        returned: kept.length,
        matchedFileBytes,
        spillPath,
        spillCount,
        hits: kept.map((h) => ({ name: h.name, file: h.file, line: h.line, kind: h.kind, context: h.context })),
      }
    },
  })

  /* ────────── 工具 3：import 图查询 ────────── */
  const toolImports = defineTool({
    name: 'project_imports',
    description: '查询某文件的 import 出边（direction=out）或谁 import 了它（direction=in），返回 边+行号+短上下文。超量落盘。',
    parameters: {
      root: { type: 'string', description: '项目根目录' },
      file: { type: 'string', description: '相对 root 的路径（或用过的相对路径）', required: true },
      direction: { type: 'string', enum: ['out', 'in'], description: 'out=该文件引用了谁；in=谁引用了该文件' },
      limit: { type: 'integer', description: '内联上限' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          file: { type: 'string' },
          direction: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          spillPath: { type: 'string' },
          spillCount: { type: 'integer' },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                line: { type: 'integer' },
                context: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, v) => {
        const lines: string[] = [`[imports ${v.direction}] ${v.file} → ${v.total} 条`]
        for (const e of v.edges ?? []) lines.push(` ${e.from}:${e.line} → ${e.to} — ${e.context}`)
        if (v.spillPath) lines.push(` [spill] 其余 ${v.spillCount} 条见 ${v.spillPath}`)
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const idx = indexerFor(args.root)
      const dir = (args.direction ?? 'in') as 'in' | 'out'
      const edges = idx.findImports(args.file, dir)
      const limit = Math.max(1, Math.floor(args.limit ?? config.maxHits))
      const kept = edges.slice(0, limit)
      let spillPath = ''
      let spillCount = 0
      if (edges.length > limit) {
        spillPath = idx.writeSpill(edges.slice(limit), cacheDir, 'imports').path
        spillCount = edges.length - limit
      }
      return {
        root: idx.root,
        file: args.file,
        direction: dir,
        total: edges.length,
        returned: kept.length,
        spillPath,
        spillCount,
        edges: kept.map((e) => ({ from: e.from, to: e.to, line: e.line, context: e.context })),
      }
    },
  })

  /* ────────── 工具 4：文件树（缓存 glob） ────────── */
  const toolFiles = defineTool({
    name: 'project_files',
    description: '列出索引内的文件相对路径（子串过滤），等价于项目内缓存 glob；超量落盘。',
    parameters: {
      root: { type: 'string', description: '项目根目录' },
      pattern: { type: 'string', description: '相对路径子串过滤（大小写不敏感）' },
      limit: { type: 'integer', description: '内联上限' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          pattern: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          spillPath: { type: 'string' },
          spillCount: { type: 'integer' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: { file: { type: 'string' }, size: { type: 'integer' } },
            },
          },
        },
      },
      render: (args, v) => {
        const lines: string[] = [`[files] pattern=${v.pattern || '(all)'} → ${v.total} 条`]
        for (const f of v.files ?? []) lines.push(` ${f.file} (${f.size}B)`)
        if (v.spillPath) lines.push(` [spill] 其余 ${v.spillCount} 条见 ${v.spillPath}`)
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const idx = indexerFor(args.root)
      const list = idx.listFiles(args.pattern)
      const limit = Math.max(1, Math.floor(args.limit ?? config.maxHits))
      const kept = list.slice(0, limit)
      let spillPath = ''
      let spillCount = 0
      if (list.length > limit) {
        spillPath = idx.writeSpill(list.slice(limit), cacheDir, 'files').path
        spillCount = list.length - limit
      }
      return {
        root: idx.root,
        pattern: args.pattern ?? '',
        total: list.length,
        returned: kept.length,
        spillPath,
        spillCount,
        files: kept.map((f) => ({ file: f.file, size: f.size })),
      }
    },
  })

  /* ────────── 工具 5：byte 指针切片（单行超大文件兜底） ────────── */
  const toolSlice = defineTool({
    name: 'project_slice_read',
    description: '按字节窗口精确读取文件的一段（不整读文件），返回 字节偏移+snippet+next 指针，可配合 find=字符串 直接定位到内容处。对单行超大文件/日志最合适（行号读取会失效）。',
    parameters: {
      root: { type: 'string', description: '项目根目录' },
      path: { type: 'string', description: '相对 root 或绝对路径', required: true },
      startBytes: { type: 'integer', description: '起始字节偏移（find 存在时会被覆盖为命中点-contextBefore）' },
      lengthBytes: { type: 'integer', description: '窗口字节数，缺省 sliceBytes' },
      find: { type: 'string', description: '可选：先定位该子串再切片（大小写不敏感）' },
      findFrom: { type: 'integer', description: 'find 搜索起始字节偏移，配合 nextByteOffset 翻页' },
      contextBefore: { type: 'integer', description: 'find 命中时往前带多少字节上下文，缺省 256' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          byteOffset: { type: 'integer' },
          lengthBytes: { type: 'integer' },
          totalBytes: { type: 'integer' },
          nextByteOffset: { type: 'integer' },
          hitByteOffset: { type: 'integer' },
          snippet: { type: 'string' },
          mayTruncate: { type: 'boolean' },
        },
      },
      render: (_args, v) => {
        const bo = v.byteOffset ?? 0
        const ln = v.lengthBytes ?? 0
        const head = [
          `[slice] ${v.path}`,
          `bytes ${bo}..${bo + ln} / total ${v.totalBytes ?? 0} (next=${v.nextByteOffset ?? 0})${v.mayTruncate ? ' [mayTruncate]' : ''}`,
        ]
        if (v.hitByteOffset !== undefined) head.push(`find@byte=${v.hitByteOffset}`)
        return text(head.join('\n') + '\n---\n' + (v.snippet ?? '') + '\n---\n' +
          `继续下一页：project_slice_read path=${v.path} findFrom=${v.nextByteOffset ?? 0} lengthBytes=${ln || config.sliceBytes}`)
      },
    },
    execute: async (args) => {
      const idx = indexerFor(args.root)
      const abs = isAbsolute(args.path) ? resolve(args.path) : resolve(idx.root, args.path)
      const r = sliceRead(abs, {
        startBytes: args.startBytes,
        lengthBytes: args.lengthBytes ?? config.sliceBytes,
        find: args.find || undefined,
        findFrom: args.findFrom || undefined,
        contextBefore: args.contextBefore ?? 256,
      })
      return {
        path: rel(idx, abs),
        byteOffset: r.byteOffset,
        lengthBytes: r.lengthBytes,
        totalBytes: r.totalBytes,
        nextByteOffset: r.nextByteOffset,
        hitByteOffset: r.hitByteOffset ?? 0,
        snippet: r.snippet,
        mayTruncate: r.mayTruncate,
      }
    },
  })

  /* ────────── 工具 6：成本探针（量化 token 收益的验收基线） ────────── */
  const toolCost = defineTool({
    name: 'project_cost_probe',
    description: '量化对比：测一次符号查询实际输出字符串与 token 估计，对照"朴素整文件读取"会花的字节/token，给出节省比例——用数据证明索引的价值。',
    parameters: {
      root: { type: 'string', description: '项目根目录' },
      symbol: { type: 'string', description: '要探测的符号/子串；缺省用全索引量级粗测' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          files: { type: 'integer' },
          symbols: { type: 'integer' },
          imports: { type: 'integer' },
          probeSymbol: { type: 'string' },
          hits: { type: 'integer' },
          outputChars: { type: 'integer' },
          outputTokens: { type: 'integer' },
          naiveBytes: { type: 'integer' },
          naiveTokens: { type: 'integer' },
          savedTokens: { type: 'integer' },
          savedPct: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, v) => text([
        `[cost] root=${v.root}`,
        `index files=${v.files} symbols=${v.symbols} imports=${v.imports}`,
        `probe "${v.probeSymbol}": hits=${v.hits}`,
        `output: chars=${v.outputChars} ≈ ${v.outputTokens} tokens`,
        `naive(整文件加载): bytes=${v.naiveBytes} ≈ ${v.naiveTokens} tokens`,
        `saved ≈ ${v.savedTokens} tokens (${v.savedPct}%)`,
        `note: ${v.note}`,
      ].join('\n')),
    },
    execute: async (args) => {
      const idx = indexerFor(args.root)
      let outputChars = 0
      let naiveBytes = 0
      let hits = 0
      let probeSymbol = args.symbol || '(whole-index)'
      if (args.symbol) {
        const r = idx.findSymbols(args.symbol)
        hits = r.hits.length
        naiveBytes = r.matchedFileBytes
        const sample = r.hits.slice(0, config.maxHits).map((h) => (`${h.file}:${h.line} ${h.name}`))
        outputChars = JSON.stringify(sample).length
      } else {
        const allFiles = idx.listFiles()
        outputChars = JSON.stringify(allFiles.slice(0, config.maxHits).map((f) => f.file)).length
        for (const f of allFiles) naiveBytes += f.size
      }
      const outputTokens = estimateTokens(outputChars)
      const naiveTokens = estimateTokens(naiveBytes)
      const savedTokens = Math.max(0, naiveTokens - outputTokens)
      const savedPct = naiveTokens > 0 ? Math.round((savedTokens / naiveTokens) * 1000) / 10 : 0
      return {
        root: idx.root,
        files: idx.status.files,
        symbols: idx.status.symbols,
        imports: idx.status.imports,
        probeSymbol,
        hits,
        outputChars,
        outputTokens,
        naiveBytes,
        naiveTokens,
        savedTokens,
        savedPct,
        note: naiveTokens > outputTokens
          ? '朴素基线=把命中的整份文件塞给模型；索引只付指针开销，且全量索引是一次性后台成本'
          : '样本太小，收益不明显；换更大项目/更聚焦的符号再测',
      }
    },
  })

  /* ────────── 注册 & 后台自愈 ────────── */
  const tools = [toolStatus, toolSymbols, toolImports, toolFiles, toolSlice, toolCost]

  // 对齐现役 tool 插件的范式：apply 里直接 ctx.tools.register（不用 ctx.effect 包装）。
  for (const t of tools) ctx.tools.register(t)

  // 后台自愈：Node 全局定时器（不依赖 timer 服务），dispose 时清除。
  const daemonTimer = setInterval(() => {
    for (const [root, idx] of indexers) {
      try {
        const rep = idx.ensure()
        log(`heal root=${root} files=${rep.totalFiles} scanned=${rep.scannedBytes}B rescanned=${rep.rescannedFiles} added=${rep.addedFiles} dropped=${rep.droppedFiles} symbols=${rep.symbols} imports=${rep.imports}`)
      } catch (e) {
        log(`heal failed root=${root}: ${String(e).slice(0, 200)}`)
      }
    }
  }, config.intervalMs)
  if (typeof daemonTimer === 'object' && daemonTimer !== null && 'unref' in daemonTimer) {
    daemonTimer.unref?.()
  }

  log(`plugin ready; defaultRoot=${defaultRoot || '(未配置，需传 root)'} cacheDir=${cacheDir} rootHashSample=${defaultRoot ? rootHash(defaultRoot) : '-'}`)
}
