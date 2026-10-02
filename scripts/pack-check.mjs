#!/usr/bin/env node
/**
 * pack-check.mjs — 阶段 H：本地构建包完整性与隔离集成检查
 *
 * 断言：
 * 1) `npm pack --dry-run --json` 产物清单：
 *    - 包含运行必需文件（lib/*.js、lib/types/*.d.ts、cordis.patch.yml、package.json、README.md）；
 *    - 不含开发残留（src/test/scripts/.git/*.tgz/缓存/报告/工作库）；
 *    - 包名 = @dsh-external/dsh-context-economy。
 * 2) 实际 `npm pack` → 干净临时目录解包 → junction 运行时依赖（本插件 dev 源
 *    node_modules，自包含，对齐 build.sh 的 junction 范式）→ 动态 import lib/index.js
 *    → 8 工具参数/执行/输出 schema/render → 跨块正则/JSON cursor
 *    → await unload（含运行中的搜索）→ 同进程连续重载清理通过。
 *
 * 退出码：0=通过；非 0=失败（打印 PACK-CHECK FAIL 原因）。
 */
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setImmediate as immediate } from 'node:timers/promises'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED = [
  'lib/index.js', 'lib/core.js', 'lib/savings.js',
  'lib/index-worker.js', 'lib/index-jobs.js', 'lib/cache-format.js',
  'lib/slice.js', 'lib/json.js',
  'lib/types/index.d.ts', 'lib/types/core.d.ts', 'lib/types/savings.d.ts',
  'lib/types/index-worker.d.ts', 'lib/types/index-jobs.d.ts', 'lib/types/cache-format.d.ts',
  'lib/types/slice.d.ts', 'lib/types/json.d.ts',
  'cordis.patch.yml', 'package.json', 'README.md',
]
const FORBIDDEN = [
  /^src\//, /^test\//, /^scripts\//, /^\.test-build\//, /^\.git\//,
  /\.tgz$/, /savings-bench/, /cost-probe/, /heal-history/, /index-[0-9a-f]+\.json/, /\.tmp$/,
]

// Throw so the awaited plugin unload and isolated scratch cleanup still run on failure.
const fail = (msg) => { throw new Error('PACK-CHECK FAIL: ' + msg) }

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Windows 上 .cmd 需经 shell 执行（Node 不原生 spawn .cmd）；用 shell:true 同时兼容两平台
const npmRun = (args) => execFileSync(npm, args, { cwd: ROOT, encoding: 'utf8', shell: true })

// ── 1) dry-run 产物断言 ──
const dry = JSON.parse(npmRun(['pack', '--dry-run', '--json']))
const paths = (dry[0]?.files ?? []).map((f) => f.path)
console.log(`dry-run 产物 ${paths.length} 项`)

const missing = REQUIRED.filter((r) => !paths.includes(r))
if (missing.length) fail(`tgz 缺失运行必需文件: ${missing.join(', ')}`)
for (const p of paths) for (const re of FORBIDDEN) if (re.test(p)) fail(`tgz 含开发残留: ${p}`)
if (dry[0]?.name !== '@dsh-external/dsh-context-economy') fail(`包名错误: ${dry[0]?.name}`)

// ── 2) 干净目录安装 + 启动 ──
const base = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
try {
  const packOut = npmRun(['pack', '--pack-destination', base]).trim()
  const tgz = join(base, packOut.split('\n').filter(Boolean).pop())
  if (!existsSync(tgz)) fail('npm pack 未产出 tgz')

  const pkgDir = join(base, 'package')
  mkdirSync(pkgDir, { recursive: true })
  // Windows 上必须用 System32 的 bsdtar（PATH 里的 Git Bash GNU tar 会把 "C:" 当远程主机）
  const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
  execFileSync(tar, ['-xzf', tgz, '--strip-components=1', '-C', pkgDir], { stdio: 'pipe' })
  for (const r of REQUIRED) if (!existsSync(join(pkgDir, r))) fail(`解包后缺 ${r}`)

  // junction 运行时依赖（整个 dev 源 node_modules，自包含；与 build.sh junction 范式同构）
  const nmLink = join(pkgDir, 'node_modules')
  execFileSync(process.execPath, ['-e', `
    const fs = require('fs');
    const p = process.argv[1], t = process.argv[2];
    fs.mkdirSync(require('path').dirname(p), { recursive: true });
    fs.symlinkSync(t, p, process.platform === 'win32' ? 'junction' : 'dir');`, nmLink, join(ROOT, 'node_modules')], { stdio: 'pipe' })

  // 动态 import 解包产物；以下 Worker 必须从该目录解析运行时文件。
  const mod = await import(pathToFileURL(join(pkgDir, 'lib/index.js')).href)
  const { IndexJobs } = await import(pathToFileURL(join(pkgDir, 'lib/index-jobs.js')).href)
  const { sliceDiagnostics } = await import(pathToFileURL(join(pkgDir, 'lib/slice.js')).href)
  if (mod.name !== '@dsh-external/dsh-context-economy') fail(`打包产物 name=${mod.name}`)
  if (typeof mod.apply !== 'function' || !mod.Config) fail('打包产物缺 apply/Config')

  const proj = join(base, 'proj')
  const cache = join(base, 'cache')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'x.ts'), 'import { dep } from "./dep.js"\nexport const x = dep\n')
  writeFileSync(join(proj, 'dep.ts'), 'export const dep = 1\n')
  writeFileSync(join(proj, 'data.json'), '{"packed":true,"continuation":2}')
  writeFileSync(join(proj, 'search.txt'), 'x'.repeat(65534) + 'NEEDLE')
  writeFileSync(join(proj, 'cancel.txt'), 'x'.repeat(128 * 1024))
  const config = {
      rootDir: proj,
      cacheDir: cache,
      skipDirs: '.git,node_modules',
      includeExts: '.ts,.js,.py,.md',
      maxScanBytes: 512 * 1024,
      maxContextLen: 240,
      maxHits: 120,
      sliceBytes: 4096,
      intervalMs: 300000,
      logFile: '',
      lowerNameOnly: true,
      savingsEnabled: true,
      savingsMaxRows: 500,
      historyMaxRows: 200,
  }

  const expected = ['project_index_status', 'project_symbols_find', 'project_imports', 'project_files',
    'project_slice_read', 'project_cost_probe', 'project_savings', 'project_json_read'].sort()
  const intervals = new Map()
  const liveJobs = new Set()
  const jobCounts = new Map()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realRun = IndexJobs.prototype.run
  const realClose = IndexJobs.prototype.close
  // Track actual unpacked jobs until close's termination promise resolves, not just until execute returns.
  IndexJobs.prototype.run = function(kind, payload, signal) {
    liveJobs.add(this)
    jobCounts.set(kind, (jobCounts.get(kind) ?? 0) + 1)
    return realRun.call(this, kind, payload, signal)
  }
  IndexJobs.prototype.close = async function() {
    await realClose.call(this)
    liveJobs.delete(this)
  }
  globalThis.setInterval = (callback, ms, ...args) => {
    const handle = realSetInterval(callback, ms, ...args)
    intervals.set(handle, callback)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    intervals.delete(handle)
    return realClearInterval(handle)
  }
  function loadedPlugin() {
    const tools = {}, cleanups = []
    const ctx = {
      tools: { register: (t) => {
        assert.equal(tools[t.name], undefined, `duplicate registration: ${t.name}`)
        tools[t.name] = t
        return () => { delete tools[t.name] }
      } },
      effect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
    }
    mod.apply(ctx, config)
    assert.deepEqual(Object.keys(tools).sort(), expected, '8 工具名与身份不变')
    assert.equal(intervals.size, 1, '每次 apply 只有一个 daemon timer')
    let unloading
    return { tools, unload() {
      return unloading ??= (async () => {
        const results = await Promise.allSettled(cleanups.map((c) => c()))
        const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason)
        if (errors.length) throw new AggregateError(errors, 'unload cleanup failed')
        assert.equal(Object.keys(tools).length, 0, 'await unload 后工具全部注销')
        assert.equal(intervals.size, 0, 'await unload 后无 daemon timer')
        assert.equal(liveJobs.size, 0, 'await unload 后所有解包 IndexJobs 已终止')
        assert.equal(sliceDiagnostics.activeWorkers, 0, 'await unload 后无 slice Worker')
      })()
    } }
  }
  const validated = new Set()
  async function call(tools, name, args) {
    const tool = tools[name]
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, args), [], `${name}: 参数 schema`)
    const result = await tool.execute(args, { signal: new AbortController().signal })
    // Match the installed registry: JSON detach before output validation/render.
    const value = JSON.parse(JSON.stringify(result))
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], `${name}: 输出 schema`)
    const rendered = tool.output.render(args, value)
    assert.ok(Array.isArray(rendered) && rendered.some((b) => b.type === 'text' && b.text.length > 0), `${name}: render`)
    validated.add(name)
    return value
  }
  let plugin
  try {
    plugin = loadedPlugin()
    const { tools } = plugin
    const status = await call(tools, 'project_index_status', { refresh: true })
    assert.equal(status.files, 2)
    assert.equal(status.pendingFiles, 0)
    assert.ok(status.verifiedAt >= status.updatedAt)
    const symbols = await call(tools, 'project_symbols_find', { name: 'x', ranking: true, boostFiles: ['x.ts'] })
    assert.equal(symbols.hits[0]?.name, 'x')
    const imports = await call(tools, 'project_imports', { file: 'dep.ts', direction: 'in' })
    assert.equal(imports.edges[0]?.from, 'x.ts')
    assert.equal(imports.edges[0]?.target, 'dep.ts')
    const files = await call(tools, 'project_files', { pattern: '.ts' })
    assert.equal(files.total, 2)
    const slice = await call(tools, 'project_slice_read', { path: 'x.ts' })
    assert.ok(slice.snippet.includes('export const x'))
    const cost = await call(tools, 'project_cost_probe', { symbol: 'x' })
    assert.equal(cost.hits, 1)
    const search = await call(tools, 'project_slice_read', { path: 'search.txt', find: 'N.{4}E', re: true, lengthBytes: 6, contextBefore: 0 })
    assert.equal(search.hitByteOffset, 65534)
    assert.equal(search.snippet, 'NEEDLE')
    const json = await call(tools, 'project_json_read', { path: 'data.json', limit: 1 })
    assert.equal(json.entries[0]?.key, 'packed')
    assert.ok(json.nextCursor)
    assert.equal(json.totalKeysKnown, false)
    const next = await call(tools, 'project_json_read', { path: 'data.json', limit: 1, cursor: json.nextCursor })
    assert.equal(next.entries[0]?.key, 'continuation')
    assert.equal(next.totalKeys, 2)
    assert.equal(next.validation, 'complete')
    const savings = await call(tools, 'project_savings', { root: proj, tool: 'project_json_read' })
    assert.equal(savings.aggregate.calls, 2)
    assert.equal(savings.byTool[0]?.key, 'project_json_read')
    assert.deepEqual([...validated].sort(), expected, '解包后8工具完整调用')
    for (const name of expected) {
      assert.ok(validateJsonSchemaValue(tools[name].parameters, { root: 42 }).length > 0, `${name}: 非法 root schema 拒绝`)
      await assert.rejects(tools[name].execute({ root: 42 }, { signal: new AbortController().signal }), /invalid arguments/, `${name}: execute 拒绝非法参数`)
    }
    assert.ok(jobCounts.get('extract') > 0 && jobCounts.get('graph') > 0 && jobCounts.get('json') >= 2,
      '解包后的 index-worker.js 实际完成提取、图谱和 JSON 任务')
    assert.equal(liveJobs.size, 0, '正常工具完成已 await IndexJobs 终止')
    assert.ok(sliceDiagnostics.startedWorkers > 0)
    assert.equal(sliceDiagnostics.startedWorkers, sliceDiagnostics.terminatedWorkers)

    const history = join(cache, 'heal-history.jsonl')
    const rows = () => readFileSync(history, 'utf8').trim().split('\n').filter(Boolean).length
    const beforeTick = rows()
    await [...intervals.values()][0]()
    assert.equal(rows(), beforeTick + 1, '解包后的 daemon 异步核验完成')

    // Terminate a genuinely active regex worker through plugin unload, then await both operations.
    const searching = tools.project_slice_read.execute({ path: 'cancel.txt', find: '(x+)+y', re: true,
      searchBudgetMs: 10000 }, { signal: new AbortController().signal })
    const rejected = assert.rejects(searching, /plugin disposed/)
    const workerDeadline = Date.now() + 2000
    while (sliceDiagnostics.activeWorkers === 0 && Date.now() < workerDeadline) await immediate()
    assert.equal(sliceDiagnostics.activeWorkers, 1, 'unload 前存在运行中的正则 Worker')
    await plugin.unload()
    await rejected

    // Two further isolated apply/unload rounds in this process exercise the package's reload lifecycle.
    const cachedIndexes = readdirSync(cache).filter((p) => p.startsWith('index-')).sort()
    for (let i = 0; i < 2; i++) {
      plugin = loadedPlugin()
      const reloaded = await call(plugin.tools, 'project_index_status', {})
      assert.equal(reloaded.files, 2)
      await plugin.unload()
      assert.deepEqual(readdirSync(cache).filter((p) => p.startsWith('index-')).sort(), cachedIndexes)
    }
    assert.equal(sliceDiagnostics.startedWorkers, sliceDiagnostics.terminatedWorkers)
    assert.deepEqual(readdirSync(cache).filter((p) => p.endsWith('.tmp')), [], '无临时写入残留')
  } finally {
    try { await plugin?.unload() } finally {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
      IndexJobs.prototype.run = realRun
      IndexJobs.prototype.close = realClose
    }
  }

  console.log('PACK-CHECK PASS')
  console.log('  tested tgz SHA256=' + createHash('sha256').update(readFileSync(tgz)).digest('hex'))
  console.log(`  tgz 文件=${paths.length}（必需 ${REQUIRED.length}/${REQUIRED.length}，无开发残留）`)
  console.log(`  解包8工具参数/执行/DSH输出schema/render OK：${expected.join(', ')}`)
  console.log('  解包Worker提取/图谱/JSON、跨块regex、JSON cursor续页、非法参数拒绝 OK')
  console.log('  await unload中止活动regex；三轮apply/unload：0工具、0定时器、0Worker、无.tmp残留')
} finally {
  if (dirname(resolve(base)) !== resolve(tmpdir()) || !resolve(base).startsWith(join(resolve(tmpdir()), 'dsh-pack-'))) {
    throw new Error('unsafe pack scratch cleanup')
  }
  rmSync(base, { recursive: true, force: true })
}
