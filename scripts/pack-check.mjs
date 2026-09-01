#!/usr/bin/env node
/**
 * pack-check.mjs — Part B：发布包完整性检查（npm pack --dry-run 断言 + 干净目录安装启动）
 *
 * 断言：
 * 1) `npm pack --dry-run --json` 产物清单：
 *    - 包含运行必需文件（lib/*.js、lib/types/*.d.ts、cordis.patch.yml、package.json、README.md）；
 *    - 不含开发残留（src/test/scripts/.git/*.tgz/缓存/报告/工作库）；
 *    - 包名 = @dsh-external/dsh-context-economy。
 * 2) 实际 `npm pack` → 干净临时目录解包 → junction 运行时依赖（本插件 dev 源
 *    node_modules，自包含，对齐 build.sh 的 junction 范式）→ 动态 import lib/index.js
 *    → apply(fake ctx) 启动成功（8 工具注册）→ dispose 清理通过。
 *
 * 退出码：0=通过；非 0=失败（打印 PACK-CHECK FAIL 原因）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED = [
  'lib/index.js', 'lib/core.js', 'lib/savings.js',
  'lib/types/index.d.ts', 'lib/types/core.d.ts', 'lib/types/savings.d.ts',
  'cordis.patch.yml', 'package.json', 'README.md',
]
const FORBIDDEN = [
  /^src\//, /^test\//, /^scripts\//, /^\.test-build\//, /^\.git\//,
  /\.tgz$/, /savings-bench/, /cost-probe/, /heal-history/, /index-[0-9a-f]+\.json/, /\.tmp$/,
]

const fail = (msg) => { console.error('PACK-CHECK FAIL: ' + msg); process.exit(1) }

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
    fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(require('path').dirname(p), { recursive: true });
    fs.symlinkSync(t, p, process.platform === 'win32' ? 'junction' : 'dir');`, nmLink, join(ROOT, 'node_modules')], { stdio: 'pipe' })

  // 动态 import 打包产物并真实 apply（启动证明）
  const mod = await import(pathToFileURL(join(pkgDir, 'lib/index.js')).href)
  if (mod.name !== '@dsh-external/dsh-context-economy') fail(`打包产物 name=${mod.name}`)
  if (typeof mod.apply !== 'function' || !mod.Config) fail('打包产物缺 apply/Config')

  const tools = {}
  const cleanups = []
  const ctx = {
    tools: { register: (t) => { tools[t.name] = t; return () => { delete tools[t.name] } } },
    effect: (fn) => { const r = fn(); if (typeof r === 'function') cleanups.push(r) },
  }
  const proj = join(base, 'proj')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'x.ts'), 'export const x = 1')
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(base, 'home')
  try {
    mod.apply(ctx, {
      rootDir: proj,
      skipDirs: '.git,node_modules',
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
    })
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
  const names = Object.keys(tools).sort()
  if (names.length !== 8) fail(`apply 注册工具数=${names.length}（应 8）`)
  for (const c of cleanups) c()
  if (Object.keys(tools).length !== 0) fail('dispose 后工具未注销')

  console.log('PACK-CHECK PASS')
  console.log(`  tgz 文件=${paths.length}（必需 ${REQUIRED.length}/${REQUIRED.length}，无开发残留）`)
  console.log(`  干净目录安装启动 OK：${names.join(', ')}（8 工具；dispose 清理通过）`)
} finally {
  rmSync(base, { recursive: true, force: true })
}
