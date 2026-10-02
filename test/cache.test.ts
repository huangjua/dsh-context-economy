import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, utimesSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ProjectIndexer, INDEX_VERSION } from '../src/core.js'
import { area, options, plugin, call } from './helpers.js'

it('invalid whole cache/rows are discarded and rebuilt, never keeping bad-row fingerprints', async () => {
  const a = area()
  try {
    a.put('a.ts', 'export const RecoverA = 1\nexport const RecoverB = 2\nexport const RecoverC = 3\n')
    const seed = new ProjectIndexer(a.root, a.cache, options)
    await seed.ensure()
    const valid = JSON.parse(readFileSync(seed.cacheFile, 'utf8'))
    const cases: Array<[string, (s: any) => void]> = [
      ['null first row', (s) => { s.symbols[0] = null }],
      ['null middle row', (s) => { s.symbols[1] = null }],
      ['missing name', (s) => { delete s.symbols[1].n }],
      ['out of bounds f', (s) => { s.symbols[1].f = s.fileList.length }],
      ['wrong root', (s) => { s.root = join(a.base, 'different') }],
      ['old cache version', (s) => { s.version = INDEX_VERSION - 1 }],
      ['missing files', (s) => { delete s.files }],
      ['bad fileList', (s) => { s.fileList = [null] }],
      ['missing graph', (s) => { delete s.graph }],
      ['bad ranks', (s) => { s.graph.ranks = {} }],
      ['null import', (s) => { s.imports = [null] }],
      ['bad symbol context', (s) => { s.symbols[0].c = 12 }],
    ]
    for (const [name, mutate] of cases) {
      const bad = structuredClone(valid); mutate(bad)
      writeFileSync(seed.cacheFile, JSON.stringify(bad))
      const recovered = new ProjectIndexer(a.root, a.cache, options)
      const report = await recovered.ensure()
      assert.equal(report.rescannedFiles, 1, name)
      assert.equal(recovered.findSymbols('Recover').hits.length, 3, name)
      assert.ok(recovered.cacheInvalidReason, name)
      assert.equal(recovered.diagnostics.activeWorkers, 0)
      await recovered.dispose()
    }
    for (const raw of ['{', 'null', '[1]', '{"version":7}']) {
      writeFileSync(seed.cacheFile, raw)
      const recovered = new ProjectIndexer(a.root, a.cache, options)
      await recovered.ensure()
      assert.equal(recovered.findSymbols('Recover').hits.length, 3)
      await recovered.dispose()
    }
    await seed.dispose()
  } finally { a.cleanup() }
})

it('scan threshold/context/exts/skip configuration invalidate caches; normalized ordering does not', async () => {
  const a = area()
  try {
    a.put('a.ts', '//'.padEnd(1300, 'x') + '\nexport const RecoverMe = 1\n')
    const small = new ProjectIndexer(a.root, a.cache, { ...options, maxScanBytes: 1024 })
    await small.ensure(); assert.equal(small.findSymbols('RecoverMe').hits.length, 0)
    const larger = new ProjectIndexer(a.root, a.cache, { ...options, maxScanBytes: 2048 })
    assert.equal((await larger.ensure()).rescannedFiles, 1)
    assert.equal(larger.findSymbols('RecoverMe').hits.length, 1)
    a.put('long.ts', 'export function ' + 'Long'.repeat(35) + '() {}\n')
    const shortContext = new ProjectIndexer(a.root, a.cache, { ...options, maxContextLen: 40 })
    await shortContext.ensure()
    assert.equal(shortContext.findSymbols('Long').hits[0].context.length, 40)
    const longContext = new ProjectIndexer(a.root, a.cache, { ...options, maxContextLen: 80 })
    await longContext.ensure()
    assert.equal(longContext.findSymbols('Long').hits[0].context.length, 80)
    const reordered = new ProjectIndexer(a.root, a.cache, { ...options, maxContextLen: 80,
      includeExts: ['JS', 'ts', '.JSON', '.ts'], skipDirs: ['.git', 'node_modules', '.git'], historyMaxRows: 10 },
    { readText: async () => { throw new Error('unchanged source must not be reread') } })
    const clean = await reordered.ensure()
    assert.equal(clean.rescannedFiles, 0); assert.equal(clean.failedFiles, 0)
    a.put('skip/b.ts', 'export const Skipped = 1\n')
    const skipped = new ProjectIndexer(a.root, a.cache, { ...options, skipDirs: [...options.skipDirs, 'skip'] })
    await skipped.ensure(); assert.equal(skipped.findSymbols('Skipped').hits.length, 0)
    const unskipped = new ProjectIndexer(a.root, a.cache, options)
    await unskipped.ensure(); assert.equal(unskipped.findSymbols('Skipped').hits.length, 1)
    a.put('c.js', 'export const IncludedJs = 1\n')
    const onlyTs = new ProjectIndexer(a.root, a.cache, { ...options, includeExts: ['.ts'] })
    await onlyTs.ensure(); assert.equal(onlyTs.findSymbols('IncludedJs').hits.length, 0)
    const withJs = new ProjectIndexer(a.root, a.cache, options)
    await withJs.ensure(); assert.equal(withJs.findSymbols('IncludedJs').hits.length, 1)
    for (const idx of [small, larger, shortContext, longContext, reordered, skipped, unskipped, onlyTs, withJs]) await idx.dispose()
  } finally { a.cleanup() }
})

it('failed source read stays pending across reload, retries and recovers without mtime changes', async () => {
  const a = area()
  try {
    a.put('a.ts', 'export const Retry = 1\n')
    const first = new ProjectIndexer(a.root, a.cache, options, { readText: async () => { throw new Error('temporary read failure') } })
    const failed = await first.ensure()
    assert.equal(failed.failedFiles, 1); assert.equal(first.status.pendingFiles, 1)
    assert.equal(first.status.verifiedAt, 0)
    assert.equal(first.findSymbols('Retry').hits.length, 0)
    const retry = new ProjectIndexer(a.root, a.cache, options)
    assert.equal((await retry.ensure()).rescannedFiles, 1)
    assert.equal(retry.status.pendingFiles, 0); assert.ok(retry.status.verifiedAt > 0)
    assert.equal(retry.findSymbols('Retry').hits.length, 1)
    await first.dispose(); await retry.dispose()
  } finally { a.cleanup() }
})

it('clean refresh updates verification time and reuses contexts without rereading unchanged sources', async () => {
  const a = area()
  let reads = 0
  try {
    a.put('a.ts', 'export const A = 1\n')
    const idx = new ProjectIndexer(a.root, a.cache, options, { readText: async (p) => { reads++; return readFile(p, 'utf8') } })
    await idx.ensure()
    const first = idx.status, builds = idx.diagnostics.contextBuilds
    await delay(5)
    const report = await idx.ensure()
    assert.equal(reads, 1); assert.equal(report.scannedBytes, 0)
    assert.equal(idx.diagnostics.contextBuilds, builds)
    assert.equal(idx.status.updatedAt, first.updatedAt)
    assert.ok(idx.status.verifiedAt > first.verifiedAt)
    const disk = JSON.parse(readFileSync(idx.verificationFile, 'utf8'))
    assert.equal(disk.verifiedAt, idx.status.verifiedAt)
    const touched = new Date(Date.now() + 2000)
    utimesSync(join(a.root, 'a.ts'), touched, touched)
    await idx.ensure()
    assert.equal(idx.diagnostics.contextBuilds, builds, 'metadata-only edits reuse the context map')
    const p = plugin(a.root, a.cache)
    try {
      const status = await call(p.tools.project_index_status, { refresh: true })
      assert.equal(status.updatedAt, idx.status.updatedAt)
      assert.ok(status.verifiedAt > first.verifiedAt)
      assert.ok(status.staleMs < Date.now() - first.verifiedAt)
    } finally { await p.dispose() }
    await idx.dispose()
  } finally { a.cleanup() }
})

it('cache write failure exposes diagnostics while memory results and clean reuse stay correct', async () => {
  const a = area()
  try {
    a.put('a.ts', 'export const InMemory = 1\n')
    const blocked = join(a.base, 'not-a-directory')
    writeFileSync(blocked, 'occupied')
    const idx = new ProjectIndexer(a.root, blocked, options)
    await idx.ensure()
    assert.ok(idx.status.cacheWriteError)
    assert.equal(idx.findSymbols('InMemory').hits.length, 1)
    assert.equal((await idx.ensure()).rescannedFiles, 0)
    assert.equal(idx.findSymbols('InMemory').hits.length, 1)
    const p = plugin(a.root, blocked, { logFile: join(a.cache, 'test.log') })
    try {
      const status = await call(p.tools.project_index_status, {})
      assert.ok(status.cacheWriteError)
      assert.ok(p.tools.project_index_status.output!.render({}, status).some((b) => b.type === 'text' && b.text.includes('cacheWriteError=')))
    }
    finally { await p.dispose() }
    assert.equal(readdirSync(a.cache).some((f) => f.includes('.tmp')), false)
    await idx.dispose()
  } finally { a.cleanup() }
})
