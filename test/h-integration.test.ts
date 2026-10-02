/** H: resource ownership across plugin-level daemon, cancellation and repeated reload.
 * Existing tools.test.ts owns the eight-tool schema/render contract; these tests
 * exercise concurrent lifetime boundaries using the real index/JSON/regex workers.
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import type { Worker } from 'node:worker_threads'
import { ProjectIndexer } from '../src/core.js'
import { IndexJobs } from '../src/index-jobs.js'
import { sliceDiagnostics } from '../src/slice.js'
import { area, call, plugin } from './helpers.js'

const names = ['project_index_status', 'project_symbols_find', 'project_imports', 'project_files',
  'project_slice_read', 'project_cost_probe', 'project_savings', 'project_json_read'].sort()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Observe actual work without replacing its implementation or adding sleeps. */
function observeResources() {
  const intervals = new Map<number, () => Promise<void>>()
  const timeouts = new Set<ReturnType<typeof setTimeout>>()
  const jobs = new Set<IndexJobs>()
  const online = new Map<IndexJobs, Promise<void>>()
  const pending = new Map<IndexJobs, string>()
  const starts = new Map<string, ReturnType<typeof deferred<IndexJobs>>>()
  let ensureStarted: ReturnType<typeof deferred<AbortSignal | undefined>> | undefined
  let nextInterval = 1
  const originals = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    run: IndexJobs.prototype.run, close: IndexJobs.prototype.close, ensure: ProjectIndexer.prototype.ensure }
  globalThis.setInterval = ((cb: () => Promise<void>) => {
    const id = nextInterval++; intervals.set(id, cb); return id
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((id: unknown) => { intervals.delete(id as number) }) as typeof clearInterval
  globalThis.setTimeout = ((cb: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const handle = originals.setTimeout(() => { timeouts.delete(handle); cb(...args) }, delay)
    timeouts.add(handle); return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    timeouts.delete(handle); originals.clearTimeout(handle)
  }) as typeof clearTimeout
  IndexJobs.prototype.run = function <T>(kind: string, payload: unknown, signal: AbortSignal): Promise<T> {
    if (!jobs.has(this)) {
      jobs.add(this)
      // `online` precedes the worker's result message, so cancellation is triggered
      // while the posted job still owns a live worker, independent of machine speed.
      const worker = (this as unknown as { worker: Worker }).worker
      online.set(this, new Promise<void>((resolve) => { worker.once('online', resolve) }))
    }
    pending.set(this, kind)
    const result = originals.run.call(this, kind, payload, signal) as Promise<T>
    starts.get(kind)?.resolve(this)
    return result.finally(() => { pending.delete(this) })
  }
  IndexJobs.prototype.close = async function (): Promise<void> {
    await originals.close.call(this)
    jobs.delete(this); online.delete(this)
  }
  ProjectIndexer.prototype.ensure = function (signal?: AbortSignal) {
    const result = originals.ensure.call(this, signal)
    ensureStarted?.resolve(signal); ensureStarted = undefined
    return result
  }
  return { intervals, timeouts, jobs, pending,
    next(kind: string) { const d = deferred<IndexJobs>(); starts.set(kind, d); return d.promise },
    nextEnsure() { const d = deferred<AbortSignal | undefined>(); ensureStarted = d; return d.promise },
    async ready(job: IndexJobs) { await online.get(job) },
    restore() {
      globalThis.setInterval = originals.setInterval; globalThis.clearInterval = originals.clearInterval
      globalThis.setTimeout = originals.setTimeout; globalThis.clearTimeout = originals.clearTimeout
      IndexJobs.prototype.run = originals.run; IndexJobs.prototype.close = originals.close
      ProjectIndexer.prototype.ensure = originals.ensure
    },
  }
}

function committed(cache: string): Record<string, string> {
  return Object.fromEntries(readdirSync(cache).sort().filter((name) =>
    name.startsWith('index-') || name.startsWith('verified-') || name === 'heal-history.jsonl')
    .map((name) => [name, readFileSync(join(cache, name), 'utf8')]))
}

it('daemon extraction, queued tool cancellation and unload preserve committed cache across three reloads',
  { timeout: 30000 }, async () => {
    const a = area(), observed = observeResources()
    let p: ReturnType<typeof plugin> | undefined
    try {
      for (let round = 0; round < 3; round++) {
        a.put('a.ts', `export const Generation${round} = ${round}\n`)
        p = plugin(a.root, a.cache)
        assert.deepEqual(Object.keys(p.tools).sort(), names)
        assert.equal(observed.intervals.size, 1)
        await call(p.tools.project_index_status, { refresh: true })
        const snapshot = committed(a.cache)
        assert.ok(Object.keys(snapshot).some((name) => name.startsWith('index-')))
        // A real extraction batch starts after the daemon discovers this edit.
        a.put('a.ts', Array.from({ length: 10000 }, (_, i) => `export const Next${round}_${i} = ${i}`).join('\n'))
        const started = observed.next('extract')
        const tick = [...observed.intervals.values()][0]()
        const job = await started
        await observed.ready(job)
        assert.equal(observed.pending.get(job), 'extract')
        const queued = new AbortController()
        const oldStatus = p.tools.project_index_status
        const enqueued = observed.nextEnsure()
        const queuedCall = assert.rejects(call(oldStatus, { refresh: true }, queued.signal), /queued cancellation|disposed/)
        const queuedSignal = await enqueued
        assert.equal(observed.pending.get(job), 'extract', 'tool refresh queues behind the running daemon')
        queued.abort(new Error('queued cancellation'))
        assert.equal(queuedSignal?.aborted, true, 'execution cancellation reaches the queued index refresh')
        await p.dispose()
        assert.equal(observed.intervals.size, 0)
        assert.equal(observed.jobs.size, 0, 'dispose awaits index worker termination')
        assert.equal(observed.pending.size, 0)
        assert.deepEqual(Object.keys(p.tools), [])
        assert.deepEqual(committed(a.cache), snapshot, 'interrupted generation is not committed')
        await queuedCall; await tick; await immediate()
        assert.deepEqual(committed(a.cache), snapshot, 'daemon cannot write after disposal returns')
        assert.equal(readdirSync(a.cache).some((name) => name.includes('.tmp')), false)
        await assert.rejects(call(oldStatus, { refresh: true }), /disposed/)
        p = undefined
      }
    } finally { await p?.dispose(); observed.restore(); a.cleanup() }
  })

it('three reloads cancel and unload concurrent JSON and malicious regex readers with no workers or timers left',
  { timeout: 30000 }, async () => {
    const a = area(), observed = observeResources()
    let p: ReturnType<typeof plugin> | undefined
    try {
      a.put('long.json', '{"large":"' + 'x'.repeat(16 * 1024 * 1024) + '"}')
      a.put('backtracking.txt', 'a'.repeat(100000) + '!')
      for (let round = 0; round < 3; round++) {
        p = plugin(a.root, a.cache)
        assert.deepEqual(Object.keys(p.tools).sort(), names)
        assert.equal(observed.intervals.size, 1)
        const abort = new AbortController()
        const started = observed.next('json')
        const oldJson = p.tools.project_json_read
        const json = assert.rejects(call(oldJson, { path: 'long.json' }, round % 2 === 0 ? abort.signal : undefined),
          round % 2 === 0 ? /reader cancellation/ : /disposed/)
        const regex = assert.rejects(call(p.tools.project_slice_read,
          { path: 'backtracking.txt', find: '(a+)+$', re: true, searchBudgetMs: 10000 },
          round % 2 === 1 ? abort.signal : undefined), round % 2 === 1 ? /reader cancellation/ : /disposed/)
        const job = await started
        await observed.ready(job)
        // Slice opens asynchronously; allow it to reach its actual search worker.
        while (sliceDiagnostics.activeWorkers === 0) await immediate()
        assert.equal(observed.pending.get(job), 'json')
        assert.equal(sliceDiagnostics.activeWorkers, 1)
        assert.equal(observed.timeouts.size, 1, 'regex budget timer is live before cancellation')
        abort.abort(new Error('reader cancellation'))
        await p.dispose()
        assert.equal(observed.jobs.size, 0, 'dispose awaits JSON worker termination')
        assert.equal(sliceDiagnostics.activeWorkers, 0, 'dispose awaits regex worker termination')
        assert.equal(observed.timeouts.size, 0, 'regex budget timer is cleared')
        assert.equal(observed.intervals.size, 0)
        assert.deepEqual(Object.keys(p.tools), [])
        await json; await regex; await immediate()
        assert.equal(observed.pending.size, 0)
        assert.deepEqual(committed(a.cache), {}, 'file readers never create an index')
        assert.equal(readdirSync(a.cache).some((name) => name.includes('.tmp')), false)
        await assert.rejects(call(oldJson, { path: 'long.json' }), /disposed/)
        p = undefined
      }
    } finally { await p?.dispose(); observed.restore(); a.cleanup() }
  })
