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
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdirSync, appendFileSync, statSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, isAbsolute, relative, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  ProjectIndexer,
  type SliceResult,
  cwdAbs,
  rootHash,
  estimateTokens,
  type IndexOptions,
} from './core.js'
import { SavingsLedger, wrapMeasured } from './savings.js'
import { IndexJobs } from './index-jobs.js'
import { sliceRead } from './slice.js'
import type { JsonScanResult } from './json.js'

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
  cacheDir: string
  skipDirs: string
  includeExts: string
  maxScanBytes: number
  maxContextLen: number
  maxHits: number
  sliceBytes: number
  intervalMs: number
  logFile: string
  lowerNameOnly: boolean
  savingsEnabled: boolean
  savingsMaxRows: number
  historyMaxRows: number
}

/** 显式注解：避免 TS2742（推断类型引用 .pnpm 内部路径，不可移植）。
 *  用 as 断言而非精确类型：字段契约由上方 `interface Config` 保证，apply() 以 config: Config 读取。 */
export const Config = z.object({
  rootDir: z.string().default(''),
  /** 索引/账本/历史/spill 的存放目录；空 = DSH_HOME/project-index（默认跟随 DSH_HOME，保持测试与多 profile 隔离）。桌面端可在 cordis.patch.yml 里覆写为 E:/Do Something/DSH备份/project-index */
  cacheDir: z.string().default(''),
  skipDirs: z.string().default(DEFAULT_SKIP),
  includeExts: z.string().default(DEFAULT_EXTS),
  maxScanBytes: z.number().min(1024).max(16 * 1024 * 1024).default(512 * 1024),
  maxContextLen: z.number().min(40).max(2000).default(240),
  maxHits: z.number().min(1).max(2000).default(120),
  sliceBytes: z.number().min(256).max(16 * 1024 * 1024).default(4096),
  intervalMs: z.number().min(5000).max(86_400_000).default(300_000),
  logFile: z.string().default(''),
  // Deprecated compatibility setting: name matching is always case-insensitive.
  lowerNameOnly: z.boolean().default(true),
  savingsEnabled: z.boolean().default(true),
  savingsMaxRows: z.number().min(1).max(1_000_000).default(500),
  historyMaxRows: z.number().min(1).max(1_000_000).default(200),
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 断言为 any 壓平 TS2742 的 .pnpm 内部路径引用；
// 字段契约由上方 interface Config 保证（apply(config: Config)），运行时 schema 行为不变
}) as any

const text = (s: string): ContentBlock[] => [{ type: 'text', text: s }]

export function apply(ctx: AppContext, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 显式配置优先；未配置回退 DSH_HOME/project-index（跟随 DSH_HOME 使测试隔离、多 profile 不串数据）
  const cacheDir = cwdAbs(config.cacheDir || join(dshHome, 'project-index'))
  // 日志跟随 cacheDir（默认 DSH_HOME/project-index，跟随 DSH_HOME 使测试隔离、多 profile 不串数据）；
  // 显式 config.logFile 仍最高优先。不再写死 C 盘的 super-injector 目录。
  const logFile = config.logFile || join(cacheDir, 'dsh-project-index.log')
  const defaultRoot = config.rootDir ? cwdAbs(config.rootDir) : ''
  // A per-apply authentication key prevents edited continuation counts/offsets.
  const cursorSecret = randomBytes(32).toString('hex')

  const opts: IndexOptions = {
    includeExts: config.includeExts.split(',').map((s) => s.trim()).filter(Boolean),
    skipDirs: config.skipDirs.split(',').map((s) => s.trim()).filter(Boolean),
    maxScanBytes: config.maxScanBytes,
    maxContextLen: config.maxContextLen,
    historyMaxRows: config.historyMaxRows,
  }

  const indexers = new Map<string, ProjectIndexer>()
  const lifetime = new AbortController()
  const readers = new Set<IndexJobs>()
  const directReads = new Set<Promise<unknown>>()
  async function trackedRead<T>(reading: Promise<T>): Promise<T> {
    directReads.add(reading)
    try { return await reading } finally { directReads.delete(reading) }
  }
  const callSignal = (exec?: ToolRunContext) => exec?.signal
    ? AbortSignal.any([lifetime.signal, exec.signal]) : lifetime.signal
  async function readJob<T>(kind: 'json', payload: unknown, exec?: ToolRunContext): Promise<T> {
    const signal = callSignal(exec)
    signal.throwIfAborted()
    const jobs = new IndexJobs()
    readers.add(jobs)
    try { return await jobs.run<T>(kind, payload, signal) }
    finally { await jobs.close(); readers.delete(jobs) }
  }

  // ── 常驻记账（Part A）：~/.dsh/project-index/savings.jsonl ──
  const savingsFile = join(cacheDir, 'savings.jsonl')
  const ledger = config.savingsEnabled ? new SavingsLedger(savingsFile, config.savingsMaxRows) : null
  /** 统一计量包装（不要在每个工具里重复）：savingsEnabled:false 时 ledger=null，零开销直通 */
  const measured = (
    toolName: string,
    execute: (args: any, exec?: ToolRunContext) => any,
    naiveBytes: (args: any, result: any) => number,
  ) => wrapMeasured(toolName, execute, {
    ledger,
    naiveBytes,
    rootOf: (args: any, result: any) => accountingRoot(args, result),
    normalizeArgs: (args: any) => effectiveArgs(toolName, args),
  })
  /** imports 的朴素基线：out/in=被查文件字节数；hotspots/orphans=结果 items 各文件字节数之和（不触发 ensure，直接查已有 indexer） */
  const naiveFileBytes = (args: any, result: any): number => {
    try {
      const root = args?.root ? cwdAbs(args.root) : defaultRoot
      const idx = indexers.get(root)
      if (!idx) return 0
      const files = args.direction === 'hotspots' || args.direction === 'orphans'
        ? (result?.items ?? []).map((it: any) => it.file)
        : [args.file]
      let total = 0
      for (const f of files) {
        try { total += statSync(idx.resolveFile(f)).size } catch { /* 忽略 */ }
      }
      return total
    } catch {
      return 0
    }
  }

  /** log 写失败告警的独立标志位（与 savings 的 warnOnce 分开，最多告警一次） */
  let logWriteWarned = false
  /** 日志大小封顶：超过 1MB 只保留尾部一半（daemon 每 tick 每 root 一行，无封顶会无限涨盘） */
  const LOG_MAX_BYTES = 1024 * 1024

  function logWarnOnce(err: unknown): void {
    if (logWriteWarned) return
    logWriteWarned = true
    try {
      console.error('[dsh-context-economy] log 写入失败（后续同类失败不再重复告警）:', err instanceof Error ? err.message : String(err))
    } catch {
      /* console 不可用则静默 */
    }
  }

  /** 大小封顶：>1MB 时只保留尾部一半（读文件 → slice 后半 → 写 .tmp → 原子 rename）。
   *  文件还不存在（stat 失败）是首次写入前的常态，不算失败、直接走 append。 */
  function trimLogIfNeeded(): void {
    let oversize = false
    try {
      oversize = statSync(logFile).size > LOG_MAX_BYTES
    } catch {
      return
    }
    if (!oversize) return
    try {
      const text = readFileSync(logFile, 'utf8')
      const lines = text.split('\n')
      const half = lines.slice(Math.floor(lines.length / 2)).filter((l) => l.trim() !== '')
      const tmp = logFile + '.tmp'
      writeFileSync(tmp, half.join('\n') + (half.length ? '\n' : ''), 'utf8')
      renameSync(tmp, logFile)
    } catch (err) {
      // 裁剪失败不致命：本轮照常 append，下轮再试；最多告警一次
      logWarnOnce(err)
    }
  }

  function log(msg: string): void {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      trimLogIfNeeded()
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {
      /* 日志失败静默（append/mkdir 失败不逐次告警，避免放大日志开销） */
    }
  }

  function rootOf(rootArg?: string): string {
    lifetime.signal.throwIfAborted()
    const root = rootArg ? cwdAbs(rootArg) : defaultRoot
    if (!root) throw new Error('未配置 rootDir 且未传 root 参数；请在插件设置里填 rootDir 或每次传 root')
    return root
  }

  function accountingRoot(args: any, result?: any): string {
    const value = typeof args?.root === 'string' && args.root
      ? args.root : typeof result?.root === 'string' && result.root ? result.root : defaultRoot
    return value ? cwdAbs(value) : '(unconfigured)'
  }

  function pageLimit(value: unknown): number {
    const limit = value ?? config.maxHits
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('limit 必须为正安全整数；maxHits 是缺省数量，显式 limit 可以更大')
    }
    return limit
  }

  function effectiveArgs(tool: string, args: any): unknown {
    const root = accountingRoot(args)
    const file = (p: unknown) => typeof p === 'string' && p
      ? resolve(root === '(unconfigured)' ? '.' : root, p) : p
    const limit = args.limit ?? config.maxHits
    switch (tool) {
      case 'project_symbols_find': return { root, name: args.name, kind: args.kind || undefined,
        limit, ranking: args.ranking === true,
        boostFiles: args.ranking === true ? (args.boostFiles ?? []).map(file) : [] }
      case 'project_imports': return { root, file: ['hotspots', 'orphans'].includes(args.direction)
        ? undefined : file(args.file), direction: args.direction ?? 'in', limit }
      case 'project_json_read': return { root, path: file(args.path), limit: args.limit ?? Math.min(config.maxHits, 1000), cursor: args.cursor || undefined }
      case 'project_slice_read': {
        const mode = args.mode ?? 'window'
        const find = mode === 'tail' ? undefined : args.find || undefined
        return { root, path: file(args.path), mode, lengthBytes: args.lengthBytes ?? config.sliceBytes,
          startBytes: mode === 'tail' || find ? undefined : args.startBytes ?? 0,
          find, findFrom: find ? args.findFrom ?? 0 : undefined,
          contextBefore: find ? args.contextBefore ?? 256 : undefined, re: find ? args.re === true : undefined,
          searchMaxBytes: find ? args.searchMaxBytes ?? (args.re ? 16 * 1024 * 1024 : 64 * 1024 * 1024) : undefined,
          searchBudgetMs: find ? args.searchBudgetMs ?? 1000 : undefined }
      }
      default: return { ...args, root }
    }
  }

  function indexerLazy(rootArg?: string): ProjectIndexer {
    const root = rootOf(rootArg)
    let idx = indexers.get(root)
    if (!idx) {
      idx = new ProjectIndexer(root, cacheDir, opts)
      indexers.set(root, idx)
    }
    return idx
  }

  /** Queries reconcile the current tree before returning; no implicit stale shortcut. */
  async function indexerFor(rootArg?: string, exec?: ToolRunContext): Promise<ProjectIndexer> {
    const idx = indexerLazy(rootArg)
    const report = await idx.ensure(callSignal(exec))
    if (report.failedFiles > 0) throw new Error(`索引核验未完成（${report.failedFiles} 个文件失败）；请重试或使用 project_index_status 查看 scanErrors`)
    return idx
  }

  const rel = (idx: { root: string }, abs: string): string => {
    const r = relative(idx.root, abs)
    return r && !r.startsWith('..') && !isAbsolute(r) ? r.replace(/\\/g, '/') : abs
  }

  /* ────────── 工具 1：索引状态（Part D：heal 时间序列 + 一致性/stale/损坏提示） ────────── */
  const toolStatus = defineTool({
    name: 'project_index_status',
    description: '查看/刷新某个根目录的增量项目索引状态（文件数、符号数、import 数、最近一次自愈扫描字节）。Part D：refresh:true 后返回最近 heal 历史 + 趋势 + staleMs + 缓存损坏计数。token 开销极低。',
    parameters: {
      root: { type: 'string', description: '项目根目录（相对插件 rootDir 时给绝对路径最稳）。缺省用 rootDir' },
      refresh: { type: 'boolean', description: '为 true 强制做一次 mtime 自愈扫描再返回（每次 heal 追加一行 history）' },
      history: { type: 'integer', description: '返回最近 N 次 heal 历史，缺省 10' },
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
          verifiedAt: { type: 'integer' },
          pendingFiles: { type: 'integer' },
          failedFiles: { type: 'integer' },
          scanErrors: { type: 'array', items: { type: 'string' } },
          cacheWriteError: { type: 'string' },
          cacheInvalidReason: { type: 'string' },
          scannedBytes: { type: 'integer' },
          rescannedFiles: { type: 'integer' },
          addedFiles: { type: 'integer' },
          droppedFiles: { type: 'integer' },
          consistency: { type: 'string' },
          staleMs: { type: 'integer' },
          cacheCorruptCount: { type: 'integer' },
          historyCorruptLines: { type: 'integer' },
          trend: {
            type: 'object',
            additionalProperties: true,
            properties: {
              scannedBytesDelta: { type: 'integer' },
              rescannedFilesDelta: { type: 'integer' },
              addedDelta: { type: 'integer' },
              droppedDelta: { type: 'integer' },
              windowCount: { type: 'integer' },
            },
          },
          history: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                ts: { type: 'integer' },
                scannedBytes: { type: 'integer' },
                rescannedFiles: { type: 'integer' },
                addedFiles: { type: 'integer' },
                droppedFiles: { type: 'integer' },
                totalFiles: { type: 'integer' },
                symbols: { type: 'integer' },
                imports: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        const s = v as any
        const lines: string[] = [
          `[index] root=${s.root}`,
          `files=${s.files} symbols=${s.symbols} imports=${s.imports} updatedAt=${s.updatedAt} verifiedAt=${s.verifiedAt}`,
          s.scannedBytes !== undefined ? `lastHeal: scannedBytes=${s.scannedBytes} rescanned=${s.rescannedFiles} added=${s.addedFiles} dropped=${s.droppedFiles}` : '',
          `consistency=${s.consistency} staleMs=${s.staleMs} cacheCorrupt=${s.cacheCorruptCount} pendingFiles=${s.pendingFiles}`,
          s.cacheWriteError ? `cacheWriteError=${s.cacheWriteError}` : '',
          s.failedFiles ? `scanErrors=${JSON.stringify(s.scanErrors)}` : '',
        ]
        const t = s.trend ?? {}
        if (t.windowCount > 0) lines.push(`trend(±${t.windowCount}行): scannedΔ=${t.scannedBytesDelta} rescannedΔ=${t.rescannedFilesDelta} addedΔ=${t.addedDelta} droppedΔ=${t.droppedDelta}`)
        const h = s.history ?? []
        if (h.length) {
          lines.push('heal-history (newest first):')
          for (const r of [...h].reverse().slice(0, 6)) {
            lines.push(`  ${new Date(r.ts).toISOString().slice(11, 19)} scanned=${r.scannedBytes}B rescanned=${r.rescannedFiles} added=${r.addedFiles} dropped=${r.droppedFiles} sym=${r.symbols} imp=${r.imports}`)
          }
        }
        return text(lines.filter(Boolean).join('\n'))
      },
    },
    execute: async (args, exec) => {
      const idx = indexerLazy(args.root)
      // 首次状态查询自动建索引（升级前 status 经 indexerFor 隐式 ensure；lazy 化后必须保住
      // 这个语义，否则全新 root 上 status 返回全零 + staleMs=纪元毫秒）；此后不带 refresh
      // 不再隐式扫描（避免每次 status 追加 heal 行）。refresh:true 时无论怎样都强制 heal。
      if (args.refresh || idx.lastReport === null) await idx.ensure(callSignal(exec))
      const rep = idx.lastReport
      const hist = idx.readHistory(idx.root, Math.max(1, Math.floor(args.history ?? 10)))
      return {
        root: idx.root,
        files: idx.status.files,
        symbols: idx.status.symbols,
        imports: idx.status.imports,
        updatedAt: idx.status.updatedAt,
        verifiedAt: idx.status.verifiedAt,
        pendingFiles: idx.status.pendingFiles,
        failedFiles: rep?.failedFiles ?? 0,
        scanErrors: rep?.scanErrors ?? [],
        cacheWriteError: idx.status.cacheWriteError,
        cacheInvalidReason: idx.status.cacheInvalidReason,
        scannedBytes: rep?.scannedBytes ?? 0,
        rescannedFiles: rep?.rescannedFiles ?? 0,
        addedFiles: rep?.addedFiles ?? 0,
        droppedFiles: rep?.droppedFiles ?? 0,
        consistency: idx.status.pendingFiles > 0 || (rep?.failedFiles ?? 0) > 0 ? 'partial_reconcile' : 'reconcile_working_tree',
        // 未成功核验时返回 0；verifiedAt=0 与 partial_reconcile 明确标记未核验状态
        staleMs: idx.status.verifiedAt === 0 ? 0 : Math.max(0, Date.now() - idx.status.verifiedAt),
        cacheCorruptCount: idx.cacheCorruptCount,
        historyCorruptLines: hist.corruptLines,
        trend: idx.historyTrend(hist.rows),
        history: hist.rows.map((r) => ({
          ts: r.ts,
          scannedBytes: r.scannedBytes,
          rescannedFiles: r.rescannedFiles,
          addedFiles: r.addedFiles,
          droppedFiles: r.droppedFiles,
          totalFiles: r.totalFiles,
          symbols: r.symbols,
          imports: r.imports,
        })),
      }
    },
  })

  /* ────────── 工具 2：符号查找（指针式，超量落盘） ────────── */
  const toolSymbols = defineTool({
    name: 'project_symbols_find',
    description: '在增量索引里按名字/子串查找函数、类、常量等符号，返回 相对路径+行号+短上下文 指针（不整文件喂给模型）。maxHits 是缺省返回数量，超出本次 limit 的部分写入 spill 文件并返回其路径。ranking=true 时按“匹配度优先 + 所在文件 PageRank 降序”排序（并列排序键，不改变命中集合）。',
    parameters: {
      root: { type: 'string', description: '项目根目录' },
      name: { type: 'string', description: '符号名或子串', required: true },
      kind: { type: 'string', description: '过滤 kind：function/class/const/type/interface/func/fn' },
      limit: { type: 'integer', description: '正整数；缺省 maxHits（默认数量），显式 limit 可大于 maxHits；余项 spill' },
      ranking: { type: 'boolean', description: '为 true 时按匹配度(完整名>前缀>子串)优先、组内按所在文件 PageRank 降序排列；缺省 false 保持旧 file+line 顺序（输出与升级前一致）' },
      boostFiles: { type: 'array', items: { type: 'string' }, description: '（进阶，仅 ranking=true 生效）会话中已提及/正在编辑的文件路径集合，命中这些文件的符号排名提前（aider repomap「mentioned files」思路，只改排序不改命中集合）' },
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
    execute: measured('project_symbols_find', async (args, exec) => {
      const idx = await indexerFor(args.root, exec)
      const boost = Array.isArray(args.boostFiles) ? args.boostFiles.filter((x: unknown): x is string => typeof x === 'string') : undefined
      const { hits, matchedFileBytes } = idx.findSymbols(args.name, args.kind, args.ranking === true, boost)
      const limit = pageLimit(args.limit)
      const kept = hits.slice(0, limit)
      let spillPath = ''
      let spillCount = 0
      if (hits.length > limit) {
        // writeSpill 失败返回 null：降级为只返回内联 top-N（spillPath 空，前端不渲染 spill 行）
        const sp = idx.writeSpill(hits.slice(limit), cacheDir, 'symbols')
        if (sp) {
          spillPath = sp.path
          spillCount = hits.length - limit
        }
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
    }, (_args, r) => r?.matchedFileBytes ?? 0),
  })

  /* ────────── 工具 3：import 图查询（Part B：+hotspots/orphans 方向） ────────── */
  const toolImports = defineTool({
    name: 'project_imports',
    description: '查询某文件的 import 出边（direction=out）或谁 import 了它（direction=in），返回 边+行号+短上下文；direction=hotspots 返回被引用 top-k（indegree+rank+短上下文），direction=orphans 返回孤立文件（in=0 且 out=0）。超量落盘。',
    parameters: {
      root: { type: 'string', description: '项目根目录' },
      file: { type: 'string', description: '相对 root 的路径（direction=out/in 时必填；hotspots/orphans 忽略）' },
      direction: { type: 'string', enum: ['out', 'in', 'hotspots', 'orphans'], description: 'out=该文件引用了谁；in=谁引用了该文件；hotspots=被引用 top-k；orphans=孤立文件' },
      limit: { type: 'integer', description: '正整数；缺省 maxHits，显式 limit 可更大；余项 spill（hotspots 即 top-k）' },
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
                specifier: { type: 'string' },
                status: { type: 'string' },
                target: { type: 'string' },
                line: { type: 'integer' },
                context: { type: 'string' },
              },
            },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                file: { type: 'string' },
                indegree: { type: 'integer' },
                rank: { type: 'number' },
                context: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, v) => {
        const vv = v as any
        if (vv.direction === 'hotspots' || vv.direction === 'orphans') {
          const lines: string[] = [`[imports ${vv.direction}] ${vv.total} 个文件`]
          for (const it of vv.items ?? []) lines.push(` ${it.file} indegree=${it.indegree} rank=${Number(it.rank).toFixed(4)} — ${it.context}`)
          if (vv.spillPath) lines.push(` [spill] 其余 ${vv.spillCount} 条见 ${vv.spillPath}`)
          return text(lines.join('\n'))
        }
        const lines: string[] = [`[imports ${v.direction}] ${v.file} → ${v.total} 条`]
        for (const e of v.edges ?? []) lines.push(` ${e.from}:${e.line} → ${e.to} [${e.status}; specifier=${JSON.stringify(e.specifier)}] — ${e.context}`)
        if (v.spillPath) lines.push(` [spill] 其余 ${v.spillCount} 条见 ${v.spillPath}`)
        return text(lines.join('\n'))
      },
    },
    execute: measured('project_imports', async (args, exec) => {
      const idx = await indexerFor(args.root, exec)
      const dir = args.direction ?? 'in'
      const limit = pageLimit(args.limit)
      if (dir === 'hotspots' || dir === 'orphans') {
        const rows = dir === 'hotspots' ? idx.findHotspots() : idx.findOrphans()
        const kept = rows.slice(0, limit)
        let spillPath = ''
        let spillCount = 0
        if (rows.length > limit) {
          const sp = idx.writeSpill(rows.slice(limit), cacheDir, 'imports-' + dir)
          if (sp) {
            spillPath = sp.path
            spillCount = rows.length - limit
          }
        }
        return {
          root: idx.root,
          direction: dir,
          total: rows.length,
          returned: kept.length,
          spillPath,
          spillCount,
          items: kept.map((r) => ({ file: r.file, indegree: r.indegree, rank: r.rank, context: r.context })),
        }
      }
      if (!args.file) throw new Error('direction=out/in 需要 file 参数')
      const edges = idx.findImports(args.file, dir as 'out' | 'in')
      const kept = edges.slice(0, limit)
      let spillPath = ''
      let spillCount = 0
      if (edges.length > limit) {
        const sp = idx.writeSpill(edges.slice(limit), cacheDir, 'imports')
        if (sp) {
          spillPath = sp.path
          spillCount = edges.length - limit
        }
      }
      return {
        root: idx.root,
        file: args.file,
        direction: dir,
        total: edges.length,
        returned: kept.length,
        spillPath,
        spillCount,
        edges: kept.map((e) => ({ from: e.from, to: e.to, specifier: e.specifier, status: e.status,
          ...(e.target ? { target: e.target } : {}), line: e.line, context: e.context })),
      }
    }, (_args, _r) => naiveFileBytes(_args, _r)),
  })

  /* ────────── 工具 4：文件树（缓存 glob） ────────── */
  const toolFiles = defineTool({
    name: 'project_files',
    description: '列出索引内的文件相对路径（子串过滤），等价于项目内缓存 glob；超量落盘。',
    parameters: {
      root: { type: 'string', description: '项目根目录' },
      pattern: { type: 'string', description: '相对路径子串过滤（大小写不敏感）' },
      limit: { type: 'integer', description: '正整数；缺省 maxHits，显式 limit 可更大；余项 spill' },
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
    execute: async (args, exec) => {
      const idx = await indexerFor(args.root, exec)
      const list = idx.listFiles(args.pattern)
      const limit = pageLimit(args.limit)
      const kept = list.slice(0, limit)
      let spillPath = ''
      let spillCount = 0
      if (list.length > limit) {
        const sp = idx.writeSpill(list.slice(limit), cacheDir, 'files')
        if (sp) {
          spillPath = sp.path
          spillCount = list.length - limit
        }
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

  /* ────────── 工具 5：UTF-8 byte 指针切片 ────────── */
  const toolSlice = defineTool({
    name: 'project_slice_read',
    description: '读取 UTF-8 文件半开字节窗口，lengthBytes 是实际返回字节数，nextByteOffset 指向下一页。必要时扩展到完整字符边界并报告调整；tail 读尾部。find 默认不区分大小写字面量，re=true 在单个可终止 Worker 的连续有界窗口匹配。预算耗尽明确标记搜索未完成。',
    parameters: {
      root: { type: 'string', description: '项目根目录，缺省 rootDir' },
      path: { type: 'string', description: '相对 root 或绝对路径', required: true },
      startBytes: { type: 'integer', description: '普通内容分页起始字节，缺省0；find 命中或 tail 模式覆盖' },
      lengthBytes: { type: 'integer', description: '请求窗口正整数1..16MiB，缺省 sliceBytes；实际范围可能因字符边界调整' },
      find: { type: 'string', description: '先搜索再切片；默认字面量不区分大小写，最多65536字符；re=true 最多256字符' },
      findFrom: { type: 'integer', description: '再次搜索的起始字节；普通翻页用 startBytes' },
      contextBefore: { type: 'integer', description: '命中前上下文字节0..16MiB，缺省256' },
      mode: { type: 'string', enum: ['window', 'tail'], description: '缺省window；tail从尾部取窗口并忽略find' },
      re: { type: 'boolean', description: '正则只在单个有界连续窗口执行，预算耗尽后无可靠跳过点时须提高预算重试' },
      searchMaxBytes: { type: 'integer', description: '搜索字节预算1..64MiB；缺省字面量64MiB、正则16MiB' },
      searchBudgetMs: { type: 'integer', description: '含启动和读取的整体时间预算1..10000ms；缺省1000ms，超时等待Worker终止' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {
        root: { type: 'string' }, path: { type: 'string' }, byteOffset: { type: 'integer' },
        lengthBytes: { type: 'integer' }, totalBytes: { type: 'integer' }, nextByteOffset: { type: 'integer' },
        hitByteOffset: { type: 'integer' }, tailOffset: { type: 'integer' }, snippet: { type: 'string' },
        mayTruncate: { type: 'boolean' }, rangeAdjusted: { type: 'boolean' },
        requestedStartBytes: { type: 'integer' }, requestedLengthBytes: { type: 'integer' },
        searchStatus: { type: 'string' }, searchComplete: { type: 'boolean' }, scannedBytes: { type: 'integer' },
        nextFindFrom: { type: 'integer' }, searchDiagnostic: { type: 'string' },
        searchScope: { type: 'string' }, searchByteStart: { type: 'integer' }, searchByteEnd: { type: 'integer' },
      } },
      render: (args, v) => {
        const vv = v as any
        const lines = [`[slice] ${vv.path}`,
          `bytes [${vv.byteOffset},${vv.nextByteOffset}) / total ${vv.totalBytes}; lengthBytes=${vv.lengthBytes}${vv.rangeAdjusted ? ' [UTF-8 range adjusted]' : ''}`]
        if (vv.hitByteOffset !== undefined) lines.push(`find@byte=${vv.hitByteOffset}`)
        if (vv.searchStatus !== 'not_requested') lines.push(`search=${vv.searchStatus} complete=${vv.searchComplete} scannedBytes=${vv.scannedBytes}`)
        if (vv.searchDiagnostic) lines.push(vv.searchDiagnostic)
        if (vv.searchScope !== 'none') lines.push(`scope=${vv.searchScope} bytes [${vv.searchByteStart},${vv.searchByteEnd})`)
        lines.push('---', vv.snippet, '---')
        if (vv.mayTruncate) lines.push('继续下一页：project_slice_read ' + JSON.stringify({ root: vv.root, path: vv.path,
          startBytes: vv.nextByteOffset, lengthBytes: vv.requestedLengthBytes }))
        if (args.find && vv.nextFindFrom !== undefined) lines.push('继续搜索：project_slice_read ' + JSON.stringify({ root: vv.root, path: vv.path,
          find: args.find, re: args.re ?? false, findFrom: vv.nextFindFrom, lengthBytes: vv.requestedLengthBytes,
          contextBefore: args.contextBefore ?? 256, searchMaxBytes: args.searchMaxBytes ?? (args.re ? 16 * 1024 * 1024 : 64 * 1024 * 1024), searchBudgetMs: args.searchBudgetMs ?? 1000 }))
        return text(lines.join('\n'))
      },
    },
    execute: measured('project_slice_read', async (args, exec) => {
      const root = rootOf(args.root)
      const abs = isAbsolute(args.path) ? resolve(args.path) : resolve(root, args.path)
      const r = await trackedRead(sliceRead(abs, { startBytes: args.startBytes,
        lengthBytes: args.lengthBytes ?? config.sliceBytes, find: args.find || undefined, findFrom: args.findFrom,
        contextBefore: args.contextBefore ?? 256, mode: args.mode, re: args.re,
        searchMaxBytes: args.searchMaxBytes, searchBudgetMs: args.searchBudgetMs }, callSignal(exec)))
      return { ...r, root, path: rel({ root }, abs) }
    }, (_args, r) => r?.totalBytes ?? 0),
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
    execute: async (args, exec) => {
      const idx = await indexerFor(args.root, exec)
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

  /* ────────── 工具 7：常驻记账查询（Part A） ────────── */
  const toolSavings = defineTool({
    name: 'project_savings',
    description: '常驻记账查询：累计每次 project_symbols_find / project_imports / project_slice_read / project_json_read 调用“朴素整文件读取 vs 指针输出”的节省（chars/naiveBytes/savedTokens）。可按 root / 工具过滤，返回累计聚合、按工具/按 root 分组与最近 N 次记录；超量落盘。token 开销极低（顺序读 savings.jsonl）。口径注意：savedTokens 是相对「命中文件整读」基线的估算上界（≈bytes/4），非真实计费差；重复查询（dupCalls）的节省未去重。',
    parameters: {
      root: { type: 'string', description: '按 root（绝对路径）过滤；缺省不过滤' },
      tool: { type: 'string', enum: ['project_symbols_find', 'project_imports', 'project_slice_read', 'project_json_read'], description: '按工具过滤；缺省不过滤' },
      limit: { type: 'integer', description: '内联返回的最近记录数，缺省 maxHits；超量部分落盘 spill' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          enabled: { type: 'boolean' },
          root: { type: 'string' },
          tool: { type: 'string' },
          totalRows: { type: 'integer' },
          corruptLines: { type: 'integer' },
          aggregate: {
            type: 'object',
            additionalProperties: true,
            properties: {
              calls: { type: 'integer' },
              failures: { type: 'integer' },
              dupCalls: { type: 'integer' },
              chars: { type: 'integer' },
              naiveBytes: { type: 'integer' },
              savedTokens: { type: 'integer' },
              savedPct: { type: 'number' },
            },
          },
          byTool: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: { key: { type: 'string' }, calls: { type: 'integer' }, savedTokens: { type: 'integer' } },
            },
          },
          byRoot: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: { key: { type: 'string' }, calls: { type: 'integer' }, savedTokens: { type: 'integer' } },
            },
          },
          recent: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                ts: { type: 'integer' },
                root: { type: 'string' },
                tool: { type: 'string' },
                chars: { type: 'integer' },
                naiveBytes: { type: 'integer' },
                savedTokens: { type: 'integer' },
                failed: { type: 'boolean' },
              },
            },
          },
          spillPath: { type: 'string' },
          spillCount: { type: 'integer' },
          note: { type: 'string' },
        },
      },
      render: (args, v) => {
        const vv = v as any
        const lines: string[] = [`[savings] ${vv.enabled ? `rows=${vv.totalRows}（bad=${vv.corruptLines}）` : 'disabled（savingsEnabled=false）'}`]
        if (vv.enabled) {
          const a = vv.aggregate ?? {}
          lines.push(` aggregate: calls=${a.calls} failures=${a.failures} dup=${a.dupCalls} chars=${a.chars} naiveBytes=${a.naiveBytes} saved≈${a.savedTokens} tokens (${a.savedPct}%)`)
          lines.push(` note: 上限口径=整读基线估算${typeof a.dupCalls === 'number' ? `; dup=${a.dupCalls} 条未去重` : ''}`)
          for (const g of vv.byTool ?? []) lines.push(`  byTool ${g.key}: calls=${g.calls} saved≈${g.savedTokens}t`)
          for (const g of vv.byRoot ?? []) lines.push(`  byRoot ${g.key}: calls=${g.calls} saved≈${g.savedTokens}t`)
          const rows = vv.recent ?? []
          if (rows.length) {
            lines.push('  recent (newest first):')
            for (const r of [...rows].reverse()) lines.push(`   ${new Date(r.ts).toISOString().slice(11, 19)} ${r.tool} saved≈${r.savedTokens}t (${r.chars}c vs ${r.naiveBytes}B)${r.failed ? ' [failed]' : ''}`)
          }
          if (vv.spillPath) lines.push(` [spill] 其余 ${vv.spillCount} 条见 ${vv.spillPath}`)
        }
        return text(lines.join('\n'))
      },
    },
    execute: async (args, exec) => {
      if (!ledger) {
        return { enabled: false, note: 'savingsEnabled=false，记账未开启；置 true 后需重载插件' }
      }
      const q = ledger.query({ root: args.root ? rootOf(args.root) : undefined, tool: args.tool, recent: pageLimit(args.limit), cacheDir })
      const out: any = {
        enabled: true,
        totalRows: q.totalRows,
        corruptLines: q.corruptLines,
        aggregate: q.aggregate,
        byTool: q.byTool,
        byRoot: q.byRoot,
        recent: q.recent.map((r) => ({ ts: r.ts, root: r.root, tool: r.tool, chars: r.chars, naiveBytes: r.naiveBytes, savedTokens: r.savedTokens, failed: r.failed })),
      }
      if (q.root) out.root = q.root
      if (q.tool) out.tool = q.tool
      if (q.spillPath) {
        out.spillPath = q.spillPath
        out.spillCount = q.spillCount
      }
      return out
    },
  })

  /* ────────── 工具 8：有界 JSON cursor 分页 ────────── */
  const toolJson = defineTool({
    name: 'project_json_read',
    description: '按 cursor 有界读取 JSON 顶层对象键；下一页从完成项边界继续，每项返回 UTF-8 半开字节范围和值摘要。只扫描当前页，完整计数前 totalKeys 未知、整文件校验未完成。默认数量 maxHits（最多1000），单页扫描16MiB/2s、输出64KiB、键4096字节、深度128；超预算有明确诊断，可用字节指针精读。',
    parameters: {
      root: { type: 'string', description: '项目根目录，缺省 rootDir' },
      path: { type: 'string', description: '相对 root 或绝对 JSON 文件路径', required: true },
      limit: { type: 'integer', description: '每页正整数，缺省 min(maxHits,1000)；硬上限1000；其余项用 cursor 访问' },
      cursor: { type: 'string', description: '上页 nextCursor；绑定文件、扫描器和插件生命周期，文件变化或插件重新加载后须从第一页重新开始' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          root: { type: 'string' }, path: { type: 'string' }, topLevel: { type: 'string' },
          error: { type: 'string' }, topPreview: { type: 'string' },
          totalKeys: { type: 'integer' }, totalKeysKnown: { type: 'boolean' }, returned: { type: 'integer' },
          hasMore: { type: 'boolean' }, nextCursor: { type: 'string' }, scannedBytes: { type: 'integer' },
          scanStartByte: { type: 'integer' }, scanEndByte: { type: 'integer' }, validation: { type: 'string' },
          elapsedMs: { type: 'number' }, valueByteStart: { type: 'integer' }, readBytes: { type: 'integer' },
          diagnosticCode: { type: 'string' }, resumeByteOffset: { type: 'integer' },
          entries: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
            key: { type: 'string' }, byteStart: { type: 'integer' }, byteEnd: { type: 'integer' }, preview: { type: 'string' },
          } } },
        },
      },
      render: (_args, v) => {
        const vv = v as any
        const lines = [`[json] ${vv.path} topLevel=${vv.topLevel} returned=${vv.returned} totalKeys=${vv.totalKeysKnown ? vv.totalKeys : 'unknown'} validation=${vv.validation}`,
          `scannedBytes=${vv.scannedBytes} bytes [${vv.scanStartByte},${vv.scanEndByte})`]
        for (const e of vv.entries ?? []) lines.push(` ${JSON.stringify(e.key)} @[${e.byteStart},${e.byteEnd}) — ${e.preview}`)
        if (vv.error) lines.push(`error=${vv.error}`)
        if (vv.diagnosticCode) lines.push(`diagnostic=${vv.diagnosticCode}`)
        if (vv.nextCursor) lines.push('继续下一页：project_json_read ' + JSON.stringify({ root: vv.root, path: vv.path, limit: _args.limit ?? Math.min(config.maxHits, 1000), cursor: vv.nextCursor }))
        if (vv.resumeByteOffset !== undefined) lines.push('精读定位：project_slice_read ' + JSON.stringify({ root: vv.root, path: vv.path, startBytes: vv.valueByteStart ?? vv.resumeByteOffset, lengthBytes: config.sliceBytes }))
        if ((vv.entries ?? []).length) lines.push('byte 范围为 UTF-8 半开区间；project_slice_read 使用 root/path/startBytes=byteStart/lengthBytes=byteEnd-byteStart 精读')
        return text(lines.join('\n'))
      },
    },
    execute: measured('project_json_read', async (args, exec) => {
      const root = rootOf(args.root)
      if (Buffer.byteLength(root, 'utf8') > 1024) throw new Error('JSON root 超过1024 UTF-8字节的输出路径预算')
      const abs = isAbsolute(args.path) ? resolve(args.path) : resolve(root, args.path)
      const limit = args.limit === undefined ? Math.min(config.maxHits, 1000) : pageLimit(args.limit)
      if (limit > 1000) throw new Error('JSON limit 硬上限1000；请使用 nextCursor 分页读取剩余结果')
      const scan = await readJob<JsonScanResult>('json', { path: abs, opts: { limit, cursor: args.cursor, maxPreview: 240, cursorSecret } }, exec)
      return { ...scan, root, path: rel({ root }, abs), returned: scan.entries.length }
    }, (args) => {
      try { return statSync(resolve(rootOf(args.root), args.path)).size } catch { return 0 }
    }),
  })

  /* ────────── 注册 & 后台自愈（同一插件生命周期） ────────── */
  const tools = [toolStatus, toolSymbols, toolImports, toolFiles, toolSlice, toolCost, toolSavings, toolJson]

  // 工具注册：scoped（borrow dsh-local-memory / dsh-session-index 的 ctx.effect 范式，
  // 见 src/index.ts 文件头"借鉴来源"）——热重载/卸载时 cordis 自动注销已注册工具，
  // reload 不产生重复工具；多次 apply 各自独立，不跨实例叠加。
  for (const t of tools) ctx.effect(() => ctx.tools.register(t), `${name}: ${t.name}`)

  // 后台自愈：Node 全局定时器（不依赖 timer 服务，unref 不阻进程退出）。
  // apply 一次只产生一个 timer（本 apply 闭包内唯一）。
  let daemonRunning = false
  const daemonTimer = setInterval(async () => {
    if (daemonRunning || lifetime.signal.aborted) return
    daemonRunning = true
    try {
      // 收集并清理消失的根目录；每个刷新完成后再继续下一项。
      const vanished: string[] = []
      for (const [root, idx] of indexers) {
        try {
          if (!existsSync(root)) {
            vanished.push(root)
            continue
          }
          const rep = await idx.ensure(lifetime.signal)
          if (lifetime.signal.aborted) return
          log(`heal root=${root} files=${rep.totalFiles} scanned=${rep.scannedBytes}B rescanned=${rep.rescannedFiles} added=${rep.addedFiles} dropped=${rep.droppedFiles} symbols=${rep.symbols} imports=${rep.imports}`)
        } catch (e) {
          if (lifetime.signal.aborted) return
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('root 不存在')) {
            vanished.push(root)
            continue
          }
          log(`heal failed root=${root}: ${msg.slice(0, 200)}`)
        }
      }
      for (const root of vanished) {
        await indexers.get(root)?.dispose()
        indexers.delete(root)
        log(`drop root=${root}（目录已消失）`)
      }
    } finally { daemonRunning = false }
  }, config.intervalMs)
  if (typeof daemonTimer === 'object' && daemonTimer !== null && 'unref' in daemonTimer) {
    daemonTimer.unref?.()
  }
  // 定时器清理绑定同一生命周期：dispose 时 clearInterval（session-index 同款
  // ctx.effect(() => () => {...}) 返回清理函数范式），reload 不产生重复定时任务。
  ctx.effect(() => async () => {
    clearInterval(daemonTimer as NodeJS.Timeout)
    lifetime.abort(new Error('plugin disposed'))
    await Promise.all([...indexers.values()].map((idx) => idx.dispose()))
    await Promise.all([...readers].map((jobs) => jobs.close()))
    await Promise.allSettled([...directReads])
    indexers.clear()
  }, `${name}: daemon cleanup`)

  log(`plugin ready; defaultRoot=${defaultRoot || '(未配置，需传 root)'} cacheDir=${cacheDir} rootHashSample=${defaultRoot ? rootHash(defaultRoot) : '-'}`)
}
