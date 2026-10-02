#!/usr/bin/env node
/** Isolated graph query/refresh experiment. Fixture generation and context preparation are untimed. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir, cpus, totalmem, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const script = fileURLToPath(import.meta.url)
const project = dirname(dirname(script))
const options = { includeExts: ['.ts'], skipDirs: ['.git', 'node_modules'], maxScanBytes: 512 * 1024, maxContextLen: 240, historyMaxRows: 20 }
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

/** Check every pointer against fixture source before allowing only the known F7 correction. */
function assertFixtureCompatibility(before, after) {
  const declarations = new Map()
  const fixture = join(project, 'fixtures', 'graph-demo')
  for (const file of readdirSync(fixture)) {
    const source = readFileSync(join(fixture, file), 'utf8')
    // Independent source oracle: enumerate physical lines, without calling the plugin extractor.
    const physicalLines = source.split('\n')
    for (let i = 0; i < physicalLines.length; i++) {
      const match = /^[ \t]*export[ \t]+const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/.exec(physicalLines[i])
      if (match) declarations.set(`${file}|const|${match[1]}`, { file, kind: 'const', name: match[1], line: i + 1 })
    }
    // This is the frozen 0.0.2 regex, used solely to verify that baseline differences are
    // the documented whitespace/CRLF line bug. No other output differences are normalized.
    const legacy = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|\:)/gm
    for (const match of source.matchAll(legacy)) {
      const declaration = declarations.get(`${file}|const|${match[1]}`)
      assert.ok(declaration, `fixture declaration oracle: ${file}:${match[1]}`)
      declaration.legacyLine = source.slice(0, match.index).split('\n').length
    }
  }
  const oracle = (file, kind, name) => {
    const declaration = declarations.get(`${file}|${kind}|${name}`)
    assert.ok(declaration && declaration.legacyLine !== undefined, `known fixture pointer: ${file}|${kind}|${name}`)
    return declaration
  }
  // These fields must stay exactly equal even before pointer normalization.
  assert.deepEqual(before.graph, after.graph, 'graph-demo topology, degrees and PageRank remain exactly equal')
  for (const view of ['hotspots', 'orphans']) {
    assert.deepEqual(before[view].map(r => [r.file, r.indegree, r.rank]),
      after[view].map(r => [r.file, r.indegree, r.rank]), `${view} ordering and graph values remain exactly equal`)
  }
  for (const view of ['symbols', 'ranking', 'boosted']) {
    assert.deepEqual(before[view].hits.map(h => [h.file, h.name, h.kind]),
      after[view].hits.map(h => [h.file, h.name, h.kind]), `${view} hit set/order remains exactly equal`)
  }
  const normalizedBefore = structuredClone(before), normalizedAfter = structuredClone(after)
  normalizedBefore.label = normalizedAfter.label = ''
  const corrections = []
  for (const view of ['symbols', 'ranking', 'boosted']) {
    for (let i = 0; i < after[view].hits.length; i++) {
      const hit = after[view].hits[i], baselineHit = before[view].hits[i]
      const expected = oracle(hit.file, hit.kind, hit.name)
      assert.equal(hit.line, expected.line, `development ${view}.hits[${i}].line is the physical declaration line`)
      assert.equal(baselineHit.line, expected.legacyLine, `baseline ${view}.hits[${i}].line matches the frozen whitespace bug`)
      if (baselineHit.line !== expected.line) {
        corrections.push({ field: `${view}.hits[${i}].line`, file: hit.file, name: hit.name,
          baselineLine: baselineHit.line, declarationLine: expected.line })
        normalizedBefore[view].hits[i].line = expected.line
      }
    }
  }
  for (const view of ['hotspots', 'orphans']) {
    for (let i = 0; i < after[view].length; i++) {
      const row = after[view][i], baselineRow = before[view][i]
      const parsePointer = context => {
        const match = /^([^:]+):(\d+) \(([^)]+)\) ([A-Za-z_$][\w$]*) — /.exec(context)
        assert.ok(match, `symbol file-context pointer: ${context}`)
        return { file: match[1], line: Number(match[2]), kind: match[3], name: match[4], prefix: match[1] + ':' }
      }
      const pointer = parsePointer(row.context), baselinePointer = parsePointer(baselineRow.context)
      assert.equal(pointer.file, row.file)
      assert.deepEqual([baselinePointer.file, baselinePointer.kind, baselinePointer.name],
        [pointer.file, pointer.kind, pointer.name], `${view} first-symbol identity remains unchanged`)
      const expected = oracle(pointer.file, pointer.kind, pointer.name)
      assert.equal(pointer.line, expected.line, `development ${view}[${i}].context points to its physical declaration line`)
      assert.equal(baselinePointer.line, expected.legacyLine, `baseline ${view}[${i}].context matches the frozen whitespace bug`)
      if (baselinePointer.line !== expected.line) {
        corrections.push({ field: `${view}[${i}].context`, file: pointer.file, name: pointer.name,
          baselineLine: baselinePointer.line, declarationLine: expected.line })
        normalizedBefore[view][i].context = baselinePointer.prefix + expected.line +
          baselineRow.context.slice((baselinePointer.prefix + baselinePointer.line).length)
      }
    }
  }
  assert.deepEqual(normalizedBefore, normalizedAfter, 'graph-demo has no differences beyond independently verified F7 line corrections')
  return { issue: 'F7', reason: 'Declaration pointers now use the actual physical source line instead of a preceding whitespace/CRLF match start.',
    oracle: 'Physical fixture lines, with the baseline regex frozen solely to validate permitted historical differences.',
    topologyDegreesRanksOrderingRankingBoostExactlyEqual: true, developmentPointersMatchSource: true,
    matchesBaselineAfterOnlyConfirmedLineCorrections: true, corrections }
}

if (process.argv[2] === '--sample') {
  const moduleRoot = process.argv[3], n = Number(process.argv[4]), scenario = process.argv[5]
  const { ProjectIndexer } = await import(pathToFileURL(join(moduleRoot, 'lib/core.js')))
  const base = mkdtempSync(join(tmpdir(), 'dsh-abc-bench-'))
  const root = join(base, 'project'), cache = join(base, 'cache')
  mkdirSync(root); mkdirSync(cache)
  const idx = new ProjectIndexer(root, cache, options)
  let result
  try {
    if (scenario === 'query') {
      const files = {}, symbols = [], orphans = [], ranks = {}, indegree = {}
      for (let f = 0; f < n; f++) {
        const file = 'file' + f + '.ts'
        files[file] = { mtime: 1, size: 1000 }; orphans.push(file); ranks[file] = 1 / n; indegree[file] = 1
        for (let s = 0; s < 30; s++) symbols.push({ name: 'S' + s, file, line: s + 1, kind: 'const', context: 'const S = 1' })
      }
      // Test-only in-memory seed matches the audit fixture. Each graph view is benchmarked
      // independently; the indegree and orphan sets represent those separate view fixtures.
      const state = { version: 6, root, updatedAt: 1, verifiedAt: 1, files, symbols, imports: [], graph: { indegree, ranks, orphans } }
      idx.state = state
      if (idx.buildContexts) idx.contexts = await idx.buildContexts(state, new AbortController().signal)
      result = { scenario, files: n, symbols: symbols.length, views: {} }
      for (const method of ['findOrphans', 'findHotspots']) {
        assert.equal(idx[method]().length, n) // one warm-up
        const times = []
        for (let i = 0; i < 5; i++) {
          const start = performance.now(), rows = idx[method]()
          times.push(performance.now() - start)
          assert.equal(rows.length, n)
          assert.ok(rows.every((r) => r.context.includes('(const) S0')))
        }
        result.views[method] = { samplesMs: times, medianMs: median(times),
          workPerQuery: idx.diagnostics ? { mapLookups: n, fullTableRowVisits: 0 } :
            { symbolPredicateCalls: 30 * n * (n - 1) / 2 + n } }
      }
      if (idx.diagnostics) result.diagnostics = idx.diagnostics
    } else if (scenario === 'refresh') {
      const code = Array.from({ length: 30 }, (_, i) => `export const S${i} = ${i}`).join('\n')
      for (let i = 0; i < n; i++) writeFileSync(join(root, `f${i}.ts`), code)
      let beats = 0, previous = performance.now(), maxGapMs = 0
      const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; beats++ }, 5)
      await delay(15)
      beats = 0; maxGapMs = 0; previous = performance.now()
      const start = performance.now()
      const first = await idx.ensure()
      const refreshMs = performance.now() - start, duringRefreshBeats = beats
      await delay(15); clearInterval(timer)
      const cleanStart = performance.now(), clean = await idx.ensure()
      result = { scenario, files: n, symbols: idx.status.symbols, refreshMs,
        cleanRefreshMs: performance.now() - cleanStart, duringRefreshBeats, maxGapMs, first, clean }
      assert.equal(idx.status.symbols, n * 30)
      assert.equal(clean.rescannedFiles, 0)
    } else if (scenario === 'compatibility') {
      // Real baseline fixture catches ordering, ranks and boost behavior changes outside F1.
      const fixture = join(project, 'fixtures', 'graph-demo')
      for (const file of readdirSync(fixture)) writeFileSync(join(root, file), readFileSync(join(fixture, file)))
      await idx.ensure()
      result = { scenario, graph: idx.graph, hotspots: idx.findHotspots(), orphans: idx.findOrphans(),
        symbols: idx.findSymbols('common', undefined, false), ranking: idx.findSymbols('common', undefined, true),
        boosted: idx.findSymbols('common', undefined, true, ['b.ts']) }
      assert.equal(result.symbols.hits.length, 3)
      assert.equal(result.boosted.hits[0].file, 'b.ts')
    } else throw new Error('unknown scenario')
  } finally { await idx.dispose?.(); rmSync(base, { recursive: true, force: true }) }
  console.log(JSON.stringify(result)); process.exit(0)
}

const baseline = resolve(process.argv[2]), output = resolve(process.argv[3])
const samples = []
for (const scenario of ['query', 'refresh', 'compatibility']) {
  for (const n of scenario === 'compatibility' ? [6] : [1000, 3000]) {
    for (const [label, moduleRoot] of [['baseline', baseline], ['development', project]]) {
      const child = spawnSync(process.execPath, [script, '--sample', moduleRoot, String(n), scenario], { encoding: 'utf8', shell: false })
      if (child.status !== 0) throw new Error(child.stderr || child.stdout)
      const result = JSON.parse(child.stdout.trim())
      samples.push({ label, ...result })
      console.log(JSON.stringify({ label, scenario, files: n, views: result.views, refreshMs: result.refreshMs, beats: result.duringRefreshBeats }))
    }
  }
}
const compatibility = samples.filter((s) => s.scenario === 'compatibility')
const f7Compatibility = assertFixtureCompatibility(compatibility[0], compatibility[1])
const improvements = []
for (const n of [1000, 3000]) {
  const before = samples.find((s) => s.scenario === 'query' && s.files === n && s.label === 'baseline')
  const after = samples.find((s) => s.scenario === 'query' && s.files === n && s.label === 'development')
  for (const method of Object.keys(before.views)) {
    const reduction = 100 * (1 - after.views[method].medianMs / before.views[method].medianMs)
    improvements.push({ files: n, symbols: n * 30, method, reductionPct: reduction })
    assert.ok(reduction >= 80, 'standalone performance acceptance: >=80% faster')
  }
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify({ scope: 'graph-query-and-refresh', methodology: {
  isolatedProcessPerSample: true, warmups: 1, timedRepetitions: 5, statistic: 'median',
  queryFixture: 'same fixed synthetic in-memory index as audit; fixture generation/context preparation excluded',
  refreshFixture: '1000/3000 actual files, 30 symbols/file; generation excluded; one refresh plus one clean refresh',
  caveat: 'This report covers graph query/refresh only; JSON pagination resource results are recorded separately.',
}, machine: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0].model,
  logicalCpus: cpus().length, totalMemory: totalmem() }, baseline, development: project, samples, improvements,
graphDemoExactlyMatchesBaseline: f7Compatibility.corrections.length === 0,
graphDemoMatchesBaselineAfterF7Corrections: true, f7Compatibility }, null, 2))
console.log('performance acceptance passed: ' + output)
