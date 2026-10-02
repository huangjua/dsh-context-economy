#!/usr/bin/env node
/** Isolated JSON pagination resource benchmark. Never writes the baseline tree. */
import { open, mkdtemp, rm, stat, writeFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir, cpus, totalmem, platform, release } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const limit = 40
if (args[0] === '--measure') {
  const [variant, modulePath, file, page] = args.slice(1)
  const { scanJsonKeys } = await import(pathToFileURL(modulePath).href)
  let cursor
  if (variant === 'new' && page === 'later') cursor = (await scanJsonKeys(file, { limit })).nextCursor
  if (global.gc) global.gc()
  const before = process.memoryUsage()
  const began = performance.now()
  const scan = variant === 'new'
    ? await scanJsonKeys(file, { limit, cursor })
    : scanJsonKeys(file, { maxPreview: 240 })
  const elapsedMs = performance.now() - began
  const retained = variant === 'new' ? scan.entries : scan.entries.slice(page === 'later' ? limit : 0, page === 'later' ? limit * 2 : limit)
  const after = process.memoryUsage()
  const size = (await stat(file)).size
  process.stdout.write(JSON.stringify({ variant, page, limit, elapsedMs, peakRssBytes: process.resourceUsage().maxRSS * 1024,
    before, after, returned: retained.length, heldEntries: scan.entries.length,
    scannedBytes: variant === 'new' ? scan.scannedBytes : size,
    readBytes: variant === 'new' ? scan.readBytes : null,
    scanStartByte: variant === 'new' ? scan.scanStartByte : 0,
    scanEndByte: variant === 'new' ? scan.scanEndByte : size,
    hasMore: variant === 'new' ? scan.hasMore : scan.entries.length > (page === 'later' ? limit * 2 : limit),
    validation: variant === 'new' ? scan.validation : 'legacy_unverified' }))
} else {
  const flag = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback }
  const baseline = resolve(flag('--baseline', 'G:/AI-Agent/deepseek harness/dsh-context-economy/lib/core.js'))
  const repeats = Number(flag('--repeats', '3'))
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeats must be 1..10')
  const outPath = resolve(flag('--out', join(project, '..', 'artifacts', 'v002-fix', 'performance-json-defg.json')))
  const reusePath = flag('--reuse-baseline', undefined)
  const previous = reusePath ? JSON.parse(await readFile(resolve(reusePath), 'utf8')) : undefined
  const scannerSourceSha256 = createHash('sha256').update(await readFile(join(project, 'src', 'json.ts'))).digest('hex')
  const baselineModuleSha256 = createHash('sha256').update(await readFile(baseline)).digest('hex')
  if (previous && (previous.baselineModuleSha256 !== baselineModuleSha256 || previous.method.repeats !== repeats || previous.method.limit !== limit)) {
    throw new Error('baseline source, repetitions or page limit changed; run the full benchmark')
  }
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-json-benchmark-'))
  const compiled = join(scratch, 'compiled')
  // Compile ONLY this owned module; no build or baseline mutation is involved.
  const compile = spawnSync(process.execPath, [join(project, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(project, 'src', 'json.ts'), '--outDir', compiled, '--module', 'NodeNext', '--target', 'ES2023', '--skipLibCheck'],
    { cwd: project, encoding: 'utf8', shell: false })
  if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr)
  await writeFile(join(compiled, 'package.json'), JSON.stringify({ type: 'module' }))
  const run = (variant, modulePath, file, page) => new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--measure', variant, modulePath, file, page],
      { cwd: project, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b)
    child.on('error', reject)
    child.on('exit', code => {
      if (code !== 0) reject(new Error(`benchmark exited ${code}: ${stderr}`))
      else { try { accept(JSON.parse(stdout)) } catch (e) { reject(e) } }
    })
  })
  const samples = previous ? previous.samples.filter(s => s.variant === 'baseline') : [], fixtures = []
  try {
    for (const keys of [100_000, 1_000_000]) {
      const file = join(scratch, `keys-${keys}.json`)
      const fd = await open(file, 'wx')
      try {
        await fd.write('{')
        for (let from = 0; from < keys; from += 5000) {
          const end = Math.min(keys, from + 5000)
          let chunk = ''
          for (let i = from; i < end; i++) chunk += `${i ? ',' : ''}"key${i}":${i}`
          await fd.write(chunk)
        }
        await fd.write('}')
      } finally { await fd.close() }
      fixtures.push({ keys, bytes: (await stat(file)).size })
      if (previous && previous.fixtures.find(f => f.keys === keys)?.bytes !== fixtures.at(-1).bytes) throw new Error('reused baseline fixture mismatch')
      for (const variant of previous ? ['new'] : ['baseline', 'new']) for (const page of ['first', 'later']) for (let repeat = 0; repeat < repeats; repeat++) {
        const sample = await run(variant, variant === 'new' ? join(compiled, 'json.js') : baseline, file, page)
        samples.push({ keys, repeat, ...sample })
        process.stderr.write(`${keys} ${variant} ${page} ${repeat + 1}/${repeats}: ${sample.elapsedMs.toFixed(2)} ms; held=${sample.heldEntries}; peakRSS=${sample.peakRssBytes}\n`)
      }
    }
    const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }
    const summary = []
    for (const keys of [100_000, 1_000_000]) for (const variant of ['baseline', 'new']) for (const page of ['first', 'later']) {
      const group = samples.filter(s => s.keys === keys && s.variant === variant && s.page === page)
      summary.push({ keys, variant, page, repeats, medianElapsedMs: median(group.map(s => s.elapsedMs)),
        medianPeakRssBytes: median(group.map(s => s.peakRssBytes)), heldEntries: group[0].heldEntries,
        scannedBytes: group[0].scannedBytes, readBytes: group[0].readBytes })
    }
    const report = { benchmark: 'json-pagination', timestamp: new Date().toISOString(), baseline,
      scannerSourceSha256, baselineModuleSha256,
      ...(previous ? { baselineSamplesReusedFrom: { path: resolve(reusePath), timestamp: previous.timestamp } } : {}),
      environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem() },
      method: { repeats, limit, independentProcessPerSample: true, fixtureGenerationExcluded: true,
        laterPage: 'new: cursor prepared before timed call; baseline: full scanner call followed by slice [40,80)',
        baselineReadBytes: 'not instrumented; legacy scanner scans full file and rereads value previews',
        newReadBytes: 'actual FileHandle.read bytes including at most 64 KiB read-ahead and one cursor boundary byte',
        scannedBytes: 'parser-consumed bytes for this page; excludes unread read-ahead',
        peakRss: 'process.resourceUsage().maxRSS, includes module initialization and cursor preparation; before/after memory also recorded',
        resources: 'fixtures and isolated compiler output live only in a fresh OS temporary directory' }, fixtures, summary, samples }
    await mkdir(dirname(outPath), { recursive: true }); await writeFile(outPath, JSON.stringify(report, null, 2))
    process.stdout.write(outPath + '\n')
  } finally {
    // Delete only the exact fresh directory returned by mkdtemp, after all child processes have exited.
    if (dirname(scratch) !== resolve(tmpdir()) || !scratch.startsWith(join(resolve(tmpdir()), 'dsh-json-benchmark-'))) throw new Error('unsafe scratch cleanup')
    await rm(scratch, { recursive: true, force: true })
  }
}
