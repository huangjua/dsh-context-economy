/**
 * lifecycle.test.ts — Part A/C：插件生命周期回归（fake ctx + fake timer）
 *
 * 借鉴来源：dsh-session-index `test/index.test.ts` 的 makeCtx（fake tools.register +
 * effect 捕获 cleanup）范式，扩展为"scoped 注册可模拟 dispose 注销"（tools.register
 * 返回注销函数、effect 捕获它），并按任务约束用可控 fake timer 代替真实长时间等待。
 *
 * 覆盖（Part C 回归清单）：
 * - 首次加载：8 工具注册 + 恰好 1 个定时器；
 * - daemon 工作：手动触发一次定时器回调（fake timer，零等待）→ heal-history 落盘；
 * - dispose：清理函数运行后定时器归零、工具全部注销；
 * - 同进程再次加载：仍 8 工具 + 1 定时器，无叠加；
 * - 连续两次 reload：apply→cleanup 三轮后 0 定时器 0 工具残留；
 * - 项目扫描缓存清理：dispose 后 daemon 停写（定时器已清）；重载复用磁盘缓存、
 *   不产生 *.tmp 残留与第二套索引文件。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'

const EXPECTED_TOOLS = [
  'project_index_status', 'project_symbols_find', 'project_imports', 'project_files',
  'project_slice_read', 'project_cost_probe', 'project_savings', 'project_json_read',
].sort()

/* ── fake ctx（borrow session-index makeCtx；扩展 scoped 注销语义） ── */
interface Tool { name: string }
function makeCtx() {
  const tools: Record<string, Tool> = {}
  const cleanups: (() => void)[] = []
  const ctx = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t
        return () => { delete tools[t.name] }
      },
    },
    effect: (fn: () => unknown) => {
      const r = fn()
      if (typeof r === 'function') cleanups.push(r as () => void)
    },
  }
  return { ctx, tools, cleanups }
}

/* ── fake timer：patch 全局 setInterval/clearInterval，可确定性触发 ── */
const liveTimers = new Map<number, { cb: () => void; ms: number }>()
let nextTimerId = 1
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
function installFakeTimers(): void {
  liveTimers.clear()
  nextTimerId = 1
  globalThis.setInterval = ((cb: () => void, ms: number): unknown => {
    const id = nextTimerId++
    liveTimers.set(id, { cb, ms })
    return id
  }) as typeof setInterval
  globalThis.clearInterval = ((id: unknown) => {
    liveTimers.delete(id as number)
  }) as typeof clearInterval
}
function restoreRealTimers(): void {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
}
const timerCount = (): number => liveTimers.size
const fireTimer = (id: number): void => liveTimers.get(id)?.cb()

const bases: string[] = []
function makeTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  bases.push(d)
  return d
}

/** 完整 Config（对齐 Config schema 默认值），apply 不经 schema 校验所以必须给全 */
function cfg(rootDir: string): Record<string, unknown> {
  return {
    rootDir,
    skipDirs: '.git,node_modules,dist,out,build,coverage',
    includeExts: '.ts,.js,.py,.md',
    maxScanBytes: 512 * 1024,
    maxContextLen: 240,
    maxHits: 120,
    sliceBytes: 4096,
    intervalMs: 1000,
    logFile: '',
    lowerNameOnly: true,
    savingsEnabled: true,
    savingsMaxRows: 500,
    historyMaxRows: 200,
  }
}

before(() => { installFakeTimers() })
after(() => {
  restoreRealTimers()
  for (const b of bases) rmSync(b, { recursive: true, force: true })
})

/** 隔离 DSH_HOME 到临时目录，返回恢复函数 */
function withTempHome(home: string): () => void {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
}

describe('Part C 生命周期回归', () => {
  beforeEach(() => { liveTimers.clear(); nextTimerId = 1 })

  it('首次加载：8 工具注册 + 恰好 1 个定时器；dispose 后 timer 归零、工具注销', () => {
    const home = makeTemp('dsh-lc-home-')
    const proj = makeTemp('dsh-lc-proj-')
    writeFileSync(join(proj, 'a.ts'), 'export const a = 1')
    const restore = withTempHome(home)
    try {
      const { ctx, tools, cleanups } = makeCtx()
      apply(ctx as never, cfg(proj) as never)
      assert.deepEqual(Object.keys(tools).sort(), EXPECTED_TOOLS, '8 个工具全部注册')
      assert.equal(timerCount(), 1, 'apply 一次只产生一个 timer')
      assert.ok(cleanups.length >= 2, 'apply 应注册清理函数（工具注销 + timer 清理）')
      for (const c of cleanups) c()
      assert.equal(timerCount(), 0, 'dispose 后 timer 归零')
      assert.deepEqual(Object.keys(tools).sort(), [], 'dispose 后工具全部注销')
    } finally {
      restore()
    }
  })

  it('daemon 工作：触发一次回调即完成 heal（fake timer，无真实等待）', async () => {
    const home = makeTemp('dsh-lc-home2-')
    const proj = makeTemp('dsh-lc-proj2-')
    writeFileSync(join(proj, 'b.ts'), 'export const b = 2')
    const restore = withTempHome(home)
    try {
      const { ctx, tools, cleanups } = makeCtx()
      apply(ctx as never, cfg(proj) as never)
      // 先经工具调用物化 indexer（indexer 是惰性创建；否则 daemon 循环没有可 heal 的目标）
      await (tools['project_index_status'] as unknown as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute({})
      const hist = join(home, 'project-index', 'heal-history.jsonl')
      assert.ok(existsSync(hist), 'status 首次调用应建索引并落 heal-history')
      const before = readFileSync(hist, 'utf8').trim().split('\n').filter(Boolean).length
      const id = [...liveTimers.keys()][0]
      assert.ok(id, '应有 1 个 timer')
      fireTimer(id) // daemon 一次 tick：增量 heal → history +1
      const after = readFileSync(hist, 'utf8').trim().split('\n').filter(Boolean).length
      assert.equal(after, before + 1, 'daemon tick 应追加一行 heal-history')
      for (const c of cleanups) c()
    } finally {
      restore()
    }
  })

  it('同进程再次加载 + 连续两次 reload：不叠加工具与定时器', () => {
    const home = makeTemp('dsh-lc-home3-')
    const proj = makeTemp('dsh-lc-proj3-')
    writeFileSync(join(proj, 'c.ts'), 'export const c = 3')
    const restore = withTempHome(home)
    try {
      const c1 = makeCtx()
      apply(c1.ctx as never, cfg(proj) as never)
      assert.equal(timerCount(), 1)
      for (const c of c1.cleanups) c()
      assert.equal(timerCount(), 0)

      const c2 = makeCtx()
      apply(c2.ctx as never, cfg(proj) as never)
      assert.deepEqual(Object.keys(c2.tools).sort(), EXPECTED_TOOLS, 'reload 后仍 8 工具（无重复）')
      assert.equal(timerCount(), 1, 'reload 后仅 1 timer')
      for (const c of c2.cleanups) c()
      assert.equal(timerCount(), 0)

      const c3 = makeCtx()
      apply(c3.ctx as never, cfg(proj) as never)
      assert.deepEqual(Object.keys(c3.tools).sort(), EXPECTED_TOOLS)
      assert.equal(timerCount(), 1)
      for (const c of c3.cleanups) c()
      assert.equal(timerCount(), 0)
      assert.equal(Object.keys(c1.tools).length + Object.keys(c2.tools).length, 0, '已 dispose 实例无工具残留')
    } finally {
      restore()
    }
  })

  it('项目扫描缓存清理：dispose 停写；重载复用磁盘缓存、无 *.tmp/第二套索引', async () => {
    const home = makeTemp('dsh-lc-home4-')
    const proj = makeTemp('dsh-lc-proj4-')
    writeFileSync(join(proj, 'd.ts'), 'export const d = 4')
    const restore = withTempHome(home)
    try {
      const c1 = makeCtx()
      apply(c1.ctx as never, cfg(proj) as never)
      await (c1.tools['project_index_status'] as unknown as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute({})
      const cacheDir = join(home, 'project-index')
      const before = readdirSync(cacheDir).filter((f) => f.startsWith('index-'))
      assert.ok(before.length >= 1, '首次 status 应建索引缓存')
      const id = [...liveTimers.keys()][0]
      fireTimer(id) // daemon 增量 heal
      for (const c of c1.cleanups) c()
      assert.equal(timerCount(), 0, 'dispose 后 daemon 停（无后续缓存写入）')

      // 同进程重载：索引器重建，但磁盘缓存复用（mtime 自愈），不产生第二套/临时残留
      const c2 = makeCtx()
      apply(c2.ctx as never, cfg(proj) as never)
      await (c2.tools['project_index_status'] as unknown as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute({})
      const after = readdirSync(cacheDir).filter((f) => f.startsWith('index-'))
      assert.deepEqual(after.sort(), before.sort(), '重载后索引缓存文件集不变（复用，无第二套）')
      const tmpLeft = readdirSync(cacheDir).filter((f) => f.endsWith('.tmp'))
      assert.deepEqual(tmpLeft, [], '无 *.tmp 残留')
      for (const c of c2.cleanups) c()
    } finally {
      restore()
    }
  })
})
