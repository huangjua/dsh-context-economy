/**
 * dsh-context-economy — savings accounting（常驻记账，§12 Part A 落地）
 * -------------------------------------------------------------------
 * 把 project_cost_probe 的"点测"升级为常驻记账：每次
 *   project_symbols_find / project_imports / project_slice_read / project_json_read
 * 调用自动累计"朴素整文件读取 vs 指针输出"的差（chars / naiveBytes / savedTokens），
 * 新增 project_savings 工具查询（按工具 / 按 root / 累计与最近 N 次，超量落盘）。
 *
 * 契约来源（完整"借鉴来源"登记见 README）：
 *  - morluto/leantoken（MIT OR Apache-2.0）leantoken.savings 语义——response accounting
 *    （记账响应开销）/ hash suppression（重复命中抑制）/ failures（失败计数）/
 *    explicit observation limits（显式观测上限）→ 逐字段映射成我们自己的 schema。
 *    *本模块未复制任何源码*，仅按其语义自建 schema 与实现（纯 TS，零新依赖）。
 *  - ryoppippi/ccusage（NOASSERTION）usage 聚合口径（按 session/model 聚合、趋势）→ 只借结构。
 *  - bowenliang123/dsh-context（MIT）compactions/prunes 统计口径 → 字段命名参考。
 *  - tinqiao-oss/engramory（MIT）cap hook → savingsMaxRows 总量封顶淘汰。
 *
 * 存储：~/.dsh/project-index/savings.jsonl，append-only；写失败最多 console.error 告警一次
 * （模块级标志位，后续同类失败静默），绝不向上抛。trim 采用迟滞触发（rowCount ≥ 2×maxRows
 * 才裁），把全量重写从"每次追加"降为"每 maxRows 次追加一次"，同时最小化共写并发窗口。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { estimateTokens } from './core.js'

/* ────────────────────────── 类型 ────────────────────────── */

/** 单次观测行（JSONL 每行一个） */
export interface SavingsRow {
  /** epoch ms */
  ts: number
  /** 查询 root（绝对路径；未配置且未传 root 时 '(unconfigured)'） */
  root: string
  /** 工具名：project_symbols_find / project_imports / project_slice_read / project_json_read */
  tool: string
  /** sha1(tool|root|canonicalArgs) 前 16 位 —— hash suppression 记账视角（重复命中可识别） */
  argsHash: string
  /** 指针输出的序列化字符数（response accounting） */
  chars: number
  /** 朴素整文件基线的字节数 */
  naiveBytes: number
  /** max(0, estimateTokens(naiveBytes) - estimateTokens(chars))，与 cost_probe 同口径 */
  savedTokens: number
  /** 该次调用是否失败（失败仍记账一行，用于 failures 计数；调用方照常抛错） */
  failed: boolean
}

export interface SavingsAggregate {
  calls: number
  failures: number
  /** 重复命中数 = calls - 去重 argsHash 数（hash suppression 记账视角） */
  dupCalls: number
  chars: number
  naiveBytes: number
  savedTokens: number
  /** 千分位取整的节省百分比（与 cost_probe savedPct 同口径） */
  savedPct: number
}

export interface SavingsGroup {
  key: string
  calls: number
  savedTokens: number
}

export interface SavingsQueryResult {
  /** 应用过的过滤条件 */
  root?: string
  tool?: string
  /** 过滤后命中的行数 */
  totalRows: number
  /** 顺序读时跳过的坏行数 */
  corruptLines: number
  aggregate: SavingsAggregate
  byTool: SavingsGroup[]
  byRoot: SavingsGroup[]
  /** 最近 N 行（最旧→最新） */
  recent: SavingsRow[]
  spillPath?: string
  spillCount?: number
}

export interface SavingsQueryOptions {
  root?: string
  tool?: string
  /** 内联返回的最近行数上限（超量 spill 到 cacheDir/spill），缺省 120 */
  recent?: number
  /** 超量落盘目录（复用 ~/.dsh/project-index 下 spill） */
  cacheDir?: string
}

export interface WrapMeasuredOptions {
  /** null → 计量关闭（savingsEnabled:false 时零开销直通，不做 JSON.stringify） */
  ledger: SavingsLedger | null
  /** 从 args/result 取朴素基线字节数（symbols→matchedFileBytes；slice→totalBytes；imports→文件 size） */
  naiveBytes: (args: any, result: any) => number
  /** 从 args/result 取 root */
  rootOf: (args: any, result: any) => string
  /** Effective defaults/paths used for repeat identity; only called when enabled. */
  normalizeArgs?: (args: any) => unknown
}

/* ────────────────────────── 纯函数 ────────────────────────── */

/** 统一 token 估计：与 project_cost_probe 同一权威实现（core.estimateTokens ≈4字符/token） */
export function savedTokensOf(naiveBytes: number, chars: number): number {
  return Math.max(0, estimateTokens(Math.max(0, Math.floor(naiveBytes))) - estimateTokens(Math.max(0, Math.floor(chars))))
}

/** 重复命中识别 hash：sha1(tool|root|canonicalArgs) 前 16 位 */
export function hashArgs(tool: string, root: string, args: unknown): string {
  let canon = ''
  try {
    canon = JSON.stringify(args ?? {}, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
      }
      return value
    })
  } catch {
    canon = String(args)
  }
  return createHash('sha1').update(tool + '|' + root + '|' + canon).digest('hex').slice(0, 16)
}

function aggregateRows(rows: SavingsRow[]): SavingsAggregate {
  const hashes = new Set<string>()
  let calls = 0
  let failures = 0
  let chars = 0
  let naiveBytes = 0
  let savedTokens = 0
  for (const r of rows) {
    calls++
    if (r.failed) failures++
    chars += r.chars
    naiveBytes += r.naiveBytes
    savedTokens += r.savedTokens
    if (r.argsHash) hashes.add(r.argsHash)
  }
  const naiveTokens = estimateTokens(naiveBytes)
  const savedPct = naiveTokens > 0 ? Math.round((Math.max(0, savedTokens) / naiveTokens) * 1000) / 10 : 0
  return { calls, failures, dupCalls: calls - hashes.size, chars, naiveBytes, savedTokens, savedPct }
}

function groupBy(rows: SavingsRow[], keyOf: (r: SavingsRow) => string): SavingsGroup[] {
  const m = new Map<string, { calls: number; savedTokens: number }>()
  for (const r of rows) {
    const k = keyOf(r)
    const e = m.get(k) ?? { calls: 0, savedTokens: 0 }
    e.calls++
    e.savedTokens += r.savedTokens
    m.set(k, e)
  }
  return [...m.entries()]
    .map(([key, v]) => ({ key, calls: v.calls, savedTokens: v.savedTokens }))
    .sort((a, b) => b.savedTokens - a.savedTokens || b.calls - a.calls || (a.key < b.key ? -1 : 1))
}

/** 超量落盘（与 core.writeSpill 同款：spill 目录 + 时间戳 + 随机后缀） */
export function spillRows(rows: unknown[], cacheDir: string, kind: string): { path: string; count: number } {
  const dir = join(cacheDir, 'spill')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8')
  return { path: file, count: rows.length }
}

/* ────────────────────────── 账本 ────────────────────────── */

/** 写失败告警的模块级标志位：最多告警一次，之后同类失败静默（避免刷屏 / 放大日志开销） */
let savingsWriteWarned = false

/** 统一的"最多告警一次"失败处理：首个失败 console.error，后续静默；绝不向上抛 */
function warnOnce(err: unknown): void {
  if (savingsWriteWarned) return
  savingsWriteWarned = true
  try {
    console.error('[dsh-context-economy] savings ledger 写入失败（后续同类失败不再重复告警）:', err instanceof Error ? err.message : String(err))
  } catch {
    /* console 不可用时保持静默 */
  }
}

export class SavingsLedger {
  readonly file: string
  readonly maxRows: number
  private rowCount: number | null = null

  constructor(file: string, maxRows: number) {
    this.file = file
    this.maxRows = Math.max(1, Math.floor(maxRows))
  }

  private countLines(): number {
    if (this.rowCount !== null) return this.rowCount
    try {
      if (!existsSync(this.file)) return (this.rowCount = 0)
      const buf = readFileSync(this.file, 'utf8')
      this.rowCount = buf === '' ? 0 : buf.split('\n').filter((l) => l.trim() !== '').length
    } catch (err) {
      // 数行失败按空账本继续（保持原容错语义），但至少可见一次
      warnOnce(err)
      this.rowCount = 0
    }
    return this.rowCount
  }

  /** 超量淘汰：保留尾部 maxRows 行（engramory cap hook 思路），原子重写 */
  private trim(): void {
    try {
      const text = readFileSync(this.file, 'utf8')
      const lines = text.split('\n').filter((l) => l.trim() !== '')
      if (lines.length <= this.maxRows) {
        // 实际行数与计数器不一致（如另一实例已裁剪）时按实际值校正记账
        this.rowCount = lines.length
        return
      }
      const kept = lines.slice(lines.length - this.maxRows)
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
      renameSync(tmp, this.file)
      this.rowCount = kept.length
    } catch (err) {
      // 裁剪失败不致命：账本继续 append，下次到达迟滞阈值再试
      warnOnce(err)
    }
  }

  /**
   * append-only 写入一行；写失败最多告警一次（不抛），调用方保证启用时才调。
   * trim 迟滞触发：仅当rowCount ≥ 2×maxRows 才裁剪——稳态下全量重写频率从
   * "每 1 次追加"降为"每 maxRows 次追加"，共写另一实例丢行的并发窗口也随之最小化。
   */
  record(row: Omit<SavingsRow, 'ts'>): void {
    // 先数行再加一（避免 append 后 countLines 读到新行导致计数器漂移）
    const n = this.countLines() + 1
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify({ ts: Date.now(), ...row }) + '\n', 'utf8')
      this.rowCount = n
    } catch (err) {
      // append 失败：这行没写出去，计数器不能 +1（成功才记账）；不抛，最多告警一次
      warnOnce(err)
      return
    }
    if (n >= 2 * this.maxRows) this.trim()
  }

  /** 顺序读 + 聚合的原料：逐行解析，坏行跳过计数 */
  readRows(): { rows: SavingsRow[]; corruptLines: number } {
    const rows: SavingsRow[] = []
    let corruptLines = 0
    try {
      if (!existsSync(this.file)) return { rows, corruptLines }
      const text = readFileSync(this.file, 'utf8')
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const r = JSON.parse(t) as SavingsRow
          if (
            typeof r.ts !== 'number' || typeof r.tool !== 'string' ||
            typeof r.chars !== 'number' || typeof r.naiveBytes !== 'number' ||
            typeof r.savedTokens !== 'number'
          ) {
            corruptLines++
            continue
          }
          rows.push(r)
        } catch {
          corruptLines++
        }
      }
    } catch {
      /* 读失败静默：当作空账本 */
    }
    return { rows, corruptLines }
  }

  query(opts: SavingsQueryOptions = {}): SavingsQueryResult {
    if (opts.root) opts = { ...opts, root: resolve(opts.root) }
    const { rows, corruptLines } = this.readRows()
    const filtered = rows.filter((r) => {
      if (opts.root && r.root !== opts.root) return false
      if (opts.tool && r.tool !== opts.tool) return false
      return true
    })
    const recentLimit = Math.max(1, Math.floor(opts.recent ?? 120))
    let spillPath: string | undefined
    let spillCount = 0
    if (opts.cacheDir && filtered.length > recentLimit) {
      // 超量：保留最新 recentLimit 行内联，旧行落盘
      const sp = spillRows(filtered.slice(0, filtered.length - recentLimit), opts.cacheDir, 'savings')
      spillPath = sp.path
      spillCount = sp.count
    }
    return {
      root: opts.root,
      tool: opts.tool,
      totalRows: filtered.length,
      corruptLines,
      aggregate: aggregateRows(filtered),
      byTool: groupBy(filtered, (r) => r.tool),
      byRoot: groupBy(filtered, (r) => r.root),
      recent: filtered.slice(-recentLimit),
      spillPath,
      spillCount,
    }
  }
}

/* ────────────────────────── 统一计量包装 ────────────────────────── */

/**
 * 统一计量包装：包住工具 execute，调用后测 outputChars=JSON.stringify(result).length，
 * 与 execute 结果里的 naive 基线（matchedFileBytes / totalBytes / 文件 size）对比得出
 * savedTokens 并记账。不改变工具输出（原样返回 result）；失败照常重抛（先记一行 failed）。
 * ledger=null（savingsEnabled:false）时零开销直通，连 JSON.stringify 都不做。
 */
export function wrapMeasured<TArgs, TResult, TExec = unknown>(
  toolName: string,
  execute: (args: TArgs, exec?: TExec) => TResult | Promise<TResult>,
  opts: WrapMeasuredOptions,
): (args: TArgs, exec?: TExec) => Promise<TResult> {
  return async (args, exec) => {
    if (!opts.ledger) return execute(args, exec)
    let result: TResult | undefined
    try {
      result = await execute(args, exec)
    } catch (err) {
      // 失败也记账（failures 计数），然后照常抛给调用方——不改变工具失败行为
      try {
        const root = opts.rootOf(args, undefined) || '(default)'
        opts.ledger.record({
          root,
          tool: toolName,
          argsHash: hashArgs(toolName, root, opts.normalizeArgs ? opts.normalizeArgs(args) : args),
          chars: 0,
          naiveBytes: 0,
          savedTokens: 0,
          failed: true,
        })
      } catch {
        /* 记账失败静默 */
      }
      throw err
    }
    try {
      const chars = JSON.stringify(result ?? {}).length
      const naive = Math.max(0, Math.floor(opts.naiveBytes(args, result) || 0))
      const root = opts.rootOf(args, result) || '(default)'
      opts.ledger.record({
        root,
        tool: toolName,
        argsHash: hashArgs(toolName, root, opts.normalizeArgs ? opts.normalizeArgs(args) : args),
        chars,
        naiveBytes: naive,
        savedTokens: savedTokensOf(naive, chars),
        failed: false,
      })
    } catch {
      /* 计量本身失败不应影响工具结果 */
    }
    return result
  }
}
