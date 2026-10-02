import { it } from 'node:test'
import assert from 'node:assert/strict'
import { unlinkSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { ProjectIndexer } from '../src/core.js'
import { area, options } from './helpers.js'

it('hotspots/orphans keep ordering and first-symbol/import context; additions/deletions update maps', async () => {
  const a = area()
  try {
    a.put('a.ts', 'import { B } from "./b.ts"\nexport const A = B\n')
    a.put('b.ts', 'export const B = 1\nexport const LaterB = 2\n')
    a.put('c.ts', 'import { B } from "./b.ts"\n')
    a.put('z.ts', '// no declarations\n')
    const idx = new ProjectIndexer(a.root, a.cache, options)
    await idx.ensure()
    const hot = idx.findHotspots()
    assert.deepEqual(hot.map((r) => [r.file, r.indegree]), [['b.ts', 2]])
    assert.equal(hot[0].context, 'b.ts:1 (const) B — export const B =')
    assert.deepEqual(idx.findOrphans().map((r) => [r.file, r.context]), [['z.ts', '(no symbols/imports)']])
    const boosted = idx.findSymbols('B', undefined, true, ['a.ts']).hits
    assert.equal(boosted[0].name, 'B', 'exact match still outranks substring')
    a.put('lonely.ts', 'export const Added = 1\n')
    await idx.ensure()
    assert.ok(idx.findOrphans().find((r) => r.file === 'lonely.ts')?.context.includes('Added'))
    unlinkSync(join(a.root, 'lonely.ts'))
    a.put('b.ts', '// now import context only\nimport { A } from "./a.ts"\n')
    await idx.ensure()
    assert.equal(idx.findOrphans().some((r) => r.file === 'lonely.ts'), false)
    assert.match(idx.findHotspots().find((r) => r.file === 'b.ts')!.context, /b.ts:2 → a.ts/)
    const visits = idx.diagnostics.contextRowsVisited, builds = idx.diagnostics.contextBuilds
    const beforeLookups = idx.diagnostics.contextLookups
    const expectedLookups = idx.findHotspots().length + idx.findOrphans().length
    assert.equal(idx.diagnostics.contextLookups - beforeLookups, expectedLookups)
    assert.equal(idx.diagnostics.contextRowsVisited, visits, 'hot queries do not revisit rows')
    await idx.ensure()
    assert.equal(idx.diagnostics.contextBuilds, builds, 'clean refresh does not rebuild maps')
    await idx.dispose()
  } finally { a.cleanup() }
})

it('same-root overlapping refreshes are serialized and inherit the committed generation', async () => {
  const a = area()
  try {
    a.put('a.ts', 'export const Serial = 1\n')
    let reads = 0, active = 0, peak = 0
    const idx = new ProjectIndexer(a.root, a.cache, options, { readText: async (p) => {
      active++; peak = Math.max(peak, active); reads++
      await immediate()
      const value = await readFile(p, 'utf8')
      active--; return value
    } })
    const [first, next] = await Promise.all([idx.ensure(), idx.ensure()])
    assert.equal(first.rescannedFiles, 1); assert.equal(next.rescannedFiles, 0)
    assert.equal(reads, 1); assert.equal(peak, 1)
    assert.equal(idx.findSymbols('Serial').hits.length, 1)
    assert.equal(idx.diagnostics.activeWorkers, 0)
    await idx.dispose()
  } finally { a.cleanup() }
})

it('long extraction/graph/cache work allows timer heartbeats and leaves no workers', async () => {
  const a = area()
  const symbols = Array.from({ length: 150 }, (_, i) => `export const S${i} = ${i}`).join('\n')
  let beats = 0
  try {
    for (let i = 0; i < 450; i++) a.put(`f${i}.ts`, symbols)
    const idx = new ProjectIndexer(a.root, a.cache, options)
    const timer = setInterval(() => { beats++ }, 5)
    try { await idx.ensure() } finally { clearInterval(timer) }
    assert.ok(beats > 5, 'timers run during the scan')
    assert.equal(idx.status.symbols, 67500)
    assert.equal(idx.diagnostics.activeWorkers, 0)
    await idx.dispose()
  } finally { a.cleanup() }
})

it('cancelled active/queued refresh and dispose cannot commit later; workers reach quiescence', async () => {
  const a = area()
  try {
    a.put('a.ts', 'export const Before = 1\n')
    const abort = new AbortController()
    let cancelDuringRead = false
    const idx: ProjectIndexer = new ProjectIndexer(a.root, a.cache, options, { readText: async (path, signal): Promise<string> => {
      if (cancelDuringRead) {
        assert.ok(idx.diagnostics.refreshes >= 2, 'cancel during an active source read')
        abort.abort(new Error('cancelled during read'))
        await immediate(); signal.throwIfAborted()
      }
      return readFile(path, 'utf8')
    } })
    await idx.ensure()
    const snapshot = readFileSync(idx.cacheFile, 'utf8')
    a.put('a.ts', 'export const After = 22\n')
    cancelDuringRead = true
    const active = idx.ensure(abort.signal)
    const cancelled = assert.rejects(active)
    await cancelled
    assert.equal(readFileSync(idx.cacheFile, 'utf8'), snapshot)
    assert.equal(idx.findSymbols('Before').hits.length, 1)
    assert.equal(idx.diagnostics.activeWorkers, 0)
    cancelDuringRead = false
    const running = idx.ensure(), queued = idx.ensure()
    const rejected = Promise.all([assert.rejects(running), assert.rejects(queued)])
    await idx.dispose(); await rejected
    assert.equal(readFileSync(idx.cacheFile, 'utf8'), snapshot)
    assert.equal(idx.diagnostics.activeWorkers, 0)
    assert.equal(readdirSync(a.cache).some((f) => f.includes('.tmp')), false)
    await assert.rejects(idx.ensure(), /disposed/)
    const cancelledFresh = new ProjectIndexer(a.root, join(a.base, 'new-cache'), options)
    const c = new AbortController(); c.abort()
    await assert.rejects(cancelledFresh.ensure(c.signal))
    assert.equal(existsSync(cancelledFresh.cacheFile), false)
    await cancelledFresh.dispose()
  } finally { a.cleanup() }
})
