import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import { sliceRead, regexFirstMatch, sliceDiagnostics, type SliceResult } from '../src/slice.js'
import { area, call, plugin } from './helpers.js'

function exact(r: SliceResult) {
  assert.equal(Buffer.byteLength(r.snippet), r.lengthBytes)
  assert.equal(r.nextByteOffset, r.byteOffset + r.lengthBytes)
  assert.ok(r.byteOffset >= 0 && r.nextByteOffset <= r.totalBytes)
}

describe('stage D: exact byte slices and bounded cross-block searches', () => {
  it('two adjacent pages have no hidden overlap; EOF and empty files make no progress claims', async () => {
    const a = area()
    try {
      const path = a.put('pages.txt', 'abcdefghijklmnop')
      const first = await sliceRead(path, { lengthBytes: 4 })
      const second = await sliceRead(path, { startBytes: first.nextByteOffset, lengthBytes: 4 })
      assert.equal(first.snippet, 'abcd'); assert.equal(second.snippet, 'efgh')
      assert.equal(first.searchStatus, 'not_requested'); assert.equal(first.hitByteOffset, undefined)
      exact(first); exact(second)
      const eof = await sliceRead(path, { startBytes: 1000, lengthBytes: 4 })
      assert.equal(eof.byteOffset, 16); assert.equal(eof.lengthBytes, 0); assert.equal(eof.mayTruncate, false)
      exact(eof)
      const empty = await sliceRead(a.put('empty.txt', ''), { lengthBytes: 1 })
      assert.equal(empty.nextByteOffset, 0); assert.equal(empty.mayTruncate, false)
      exact(empty)
    } finally { a.cleanup() }
  })

  it('tail returns the final exact half-open range', async () => {
    const a = area()
    try {
      const r = await sliceRead(a.put('log.txt', '123456789'), { mode: 'tail', lengthBytes: 4, find: 'ignored' })
      assert.equal(r.snippet, '6789'); assert.equal(r.tailOffset, 5)
      assert.equal(r.nextByteOffset, 9); assert.equal(r.mayTruncate, false)
      assert.equal(r.searchStatus, 'not_requested'); exact(r)
    } finally { a.cleanup() }
  })

  it('UTF-8 boundaries are explicit and one-byte pages cannot loop on Chinese or emoji', async () => {
    const a = area()
    try {
      const text = '\ufeff中😀文x'
      const path = a.put('unicode.txt', text)
      let position = 0, joined = ''
      while (position < Buffer.byteLength(text)) {
        const r = await sliceRead(path, { startBytes: position, lengthBytes: 1 })
        exact(r); assert.ok(r.nextByteOffset > position)
        joined += r.snippet; position = r.nextByteOffset
      }
      assert.equal(joined, text)
      const inside = await sliceRead(path, { startBytes: 4, lengthBytes: 2 })
      assert.equal(inside.byteOffset, 6); assert.equal(inside.snippet, '😀')
      assert.equal(inside.rangeAdjusted, true); assert.equal(inside.requestedStartBytes, 4)
      exact(inside)
      const tail = await sliceRead(path, { mode: 'tail', lengthBytes: 6 })
      assert.equal(tail.snippet, '文x'); assert.equal(tail.tailOffset, 10); exact(tail)
    } finally { a.cleanup() }
  })

  it('rejects zero/negative/fractional/infinite and oversized lengths, invalid offsets and invalid UTF-8', async () => {
    const a = area()
    try {
      const path = a.put('plain.txt', 'abc')
      for (const lengthBytes of [0, -1, 1.5, Infinity, NaN, 16 * 1024 * 1024 + 1]) {
        await assert.rejects(sliceRead(path, { lengthBytes }), /slice_invalid_lengthBytes/)
      }
      await assert.rejects(sliceRead(path, { startBytes: -1 }), /slice_invalid_startBytes/)
      writeFileSync(path, Buffer.from([0xff, 0xfe]))
      await assert.rejects(sliceRead(path, {}), /slice_invalid_utf8/)
    } finally { a.cleanup() }
  })

  it('byte zero is a real hit, a completed miss has no fabricated hit', async () => {
    const a = area()
    try {
      const path = a.put('zero.txt', 'NEEDLE trailing')
      const r = await sliceRead(path, { find: 'needle', lengthBytes: 6, contextBefore: 0 })
      assert.equal(r.hitByteOffset, 0); assert.equal(r.searchStatus, 'matched'); assert.equal(r.snippet, 'NEEDLE')
      exact(r)
      const missing = await sliceRead(path, { find: 'not here' })
      assert.equal(missing.hitByteOffset, undefined); assert.equal(missing.searchStatus, 'not_found')
      assert.equal(missing.searchComplete, true); assert.equal(missing.nextFindFrom, undefined)
    } finally { a.cleanup() }
  })

  it('literal matches across the 65536 boundary with one worker', async () => {
    const a = area()
    try {
      const path = a.put('boundary.txt', 'x'.repeat(65533) + 'NEEDLE' + 'tail')
      const before = sliceDiagnostics.startedWorkers
      const r = await sliceRead(path, { find: 'needle', contextBefore: 0, lengthBytes: 6 })
      assert.equal(r.hitByteOffset, 65533); assert.equal(r.snippet, 'NEEDLE')
      assert.equal(sliceDiagnostics.startedWorkers - before, 1)
      assert.equal(sliceDiagnostics.activeWorkers, 0); exact(r)
    } finally { a.cleanup() }
  })

  it('Chinese and emoji spanning a read block are decoded without lost bytes', async () => {
    const a = area()
    try {
      for (const [padding, needle] of [[65535, '中文😀'], [65534, '😀中文']] as const) {
        const path = a.put(`unicode-${padding}.txt`, 'x'.repeat(padding) + needle + 'tail')
        const r = await sliceRead(path, { find: needle, contextBefore: 0, lengthBytes: Buffer.byteLength(needle) })
        assert.equal(r.hitByteOffset, padding); assert.equal(r.snippet, needle); exact(r)
      }
    } finally { a.cleanup() }
  })

  it('case folding that changes UTF-16 length maps offsets back to the original UTF-8 bytes', async () => {
    const a = area()
    try {
      const text = '中İ😀NeEdLe'
      const path = a.put('case.txt', text)
      const r = await sliceRead(path, { find: 'needle', contextBefore: 0, lengthBytes: 6 })
      assert.equal(r.hitByteOffset, Buffer.byteLength('中İ😀')); assert.equal(r.snippet, 'NeEdLe'); exact(r)
      const expanded = await sliceRead(path, { find: 'i\u0307😀', contextBefore: 0, lengthBytes: 6 })
      assert.equal(expanded.hitByteOffset, 3); assert.equal(expanded.snippet, 'İ😀'); exact(expanded)
    } finally { a.cleanup() }
  })

  it('regex matches across blocks, including matches much longer than any guessed overlap', async () => {
    const a = area()
    try {
      const text = 'x'.repeat(65533) + 'BEGIN' + 'a'.repeat(90000) + 'END'
      const path = a.put('regex-long.txt', text)
      const before = sliceDiagnostics.startedWorkers
      const r = await sliceRead(path, { find: 'BEGINa{90000}END', re: true, contextBefore: 0, lengthBytes: 5, searchBudgetMs: 3000 })
      assert.equal(r.hitByteOffset, 65533); assert.equal(r.snippet, 'BEGIN'); exact(r)
      assert.equal(sliceDiagnostics.startedWorkers - before, 1)
      assert.equal(sliceDiagnostics.activeWorkers, 0)
      const unicode = await sliceRead(a.put('unicode-re.txt', 'x'.repeat(65535) + '中😀END'), {
        find: '中😀END', re: true, contextBefore: 0, lengthBytes: 10,
      })
      assert.equal(unicode.hitByteOffset, 65535); assert.equal(unicode.snippet, '中😀END'); exact(unicode)
    } finally { a.cleanup() }
  })

  it('literal byte-budget continuation preserves a partial cross-budget match', async () => {
    const a = area()
    try {
      const path = a.put('continue.txt', 'x'.repeat(100) + 'NEEDLEtail')
      const first = await sliceRead(path, { find: 'needle', searchMaxBytes: 103 })
      assert.equal(first.searchStatus, 'byte_budget'); assert.equal(first.searchComplete, false)
      assert.equal(first.scannedBytes, 103); assert.equal(first.nextFindFrom, 100)
      const second = await sliceRead(path, { find: 'needle', findFrom: first.nextFindFrom, searchMaxBytes: 103, contextBefore: 0 })
      assert.equal(second.hitByteOffset, 100); assert.equal(second.searchStatus, 'matched')
    } finally { a.cleanup() }
  })

  it('regex byte budget is explicitly incomplete, and refuses an unsafe cross-window skip pointer', async () => {
    const a = area()
    try {
      const path = a.put('bounded.txt', 'BEGIN' + 'a'.repeat(4000) + 'END')
      const r = await sliceRead(path, { find: 'BEGINa+END', re: true, searchMaxBytes: 1024 })
      assert.equal(r.searchStatus, 'byte_budget'); assert.equal(r.searchComplete, false)
      assert.equal(r.nextFindFrom, undefined); assert.equal(r.hitByteOffset, undefined)
      assert.match(r.searchDiagnostic!, /retry the same findFrom/)
      const retry = await sliceRead(path, { find: 'BEGINa+END', re: true, searchMaxBytes: 8192 })
      assert.equal(retry.hitByteOffset, 0)
    } finally { a.cleanup() }
  })

  it('bounded regex anchor/lookaround semantics expose the actual searched substring', async () => {
    const a = area()
    try {
      const path = a.put('anchors.txt', 'aaaBBBccc')
      const r = await sliceRead(path, { find: '^BBB$', re: true, findFrom: 3, searchMaxBytes: 3, contextBefore: 0 })
      assert.equal(r.hitByteOffset, 3)
      assert.equal(r.searchScope, 'bounded_regex_window')
      assert.equal(r.searchByteStart, 3); assert.equal(r.searchByteEnd, 6)
      assert.equal(r.searchComplete, false)
      assert.match(r.searchDiagnostic!, /anchors and lookaround see these window boundaries/)
    } finally { a.cleanup() }
  })

  it('a tiny literal budget cannot produce a zero-progress retry pointer', async () => {
    const a = area()
    try {
      const r = await sliceRead(a.put('tiny.txt', 'NEEDLEtail'), { find: 'NEEDLE', searchMaxBytes: 1 })
      assert.equal(r.searchStatus, 'byte_budget'); assert.equal(r.nextFindFrom, undefined)
      assert.match(r.searchDiagnostic!, /increase searchMaxBytes/)
    } finally { a.cleanup() }
  })

  it('time budgets bound malicious backtracking without blocking heartbeat or leaving workers', async () => {
    const a = area()
    try {
      const path = a.put('redos.txt', 'a'.repeat(100000) + '!')
      let heartbeats = 0
      const timer = setInterval(() => { heartbeats++ }, 5)
      const started = Date.now()
      try {
        const r = await sliceRead(path, { find: '(a+)+$', re: true, searchBudgetMs: 150 })
        assert.equal(r.searchStatus, 'time_budget'); assert.equal(r.searchComplete, false)
        assert.equal(r.nextFindFrom, undefined)
        assert.ok(heartbeats > 2)
        assert.ok(Date.now() - started < 2000)
        assert.equal(sliceDiagnostics.activeWorkers, 0)
      } finally { clearInterval(timer) }
      await assert.rejects(regexFirstMatch('a'.repeat(100000) + '!', /(a+)+$/, 100), /slice_find_regex_timeout/)
      assert.equal(sliceDiagnostics.activeWorkers, 0)
    } finally { a.cleanup() }
  })

  it('abort rejects only after the worker has been terminated, including pre-aborted calls', async () => {
    const a = area()
    try {
      const path = a.put('cancel.txt', 'a'.repeat(100000) + '!')
      const ac = new AbortController()
      const p = sliceRead(path, { find: '(a+)+$', re: true, searchBudgetMs: 5000 }, ac.signal)
      setTimeout(() => ac.abort(new Error('test cancelled')), 80)
      await assert.rejects(p, /test cancelled/)
      assert.equal(sliceDiagnostics.activeWorkers, 0)
      const before = sliceDiagnostics.startedWorkers
      await assert.rejects(sliceRead(path, { find: 'a' }, ac.signal), /test cancelled/)
      assert.equal(sliceDiagnostics.startedWorkers, before)
      assert.equal(sliceDiagnostics.startedWorkers, sliceDiagnostics.terminatedWorkers)
    } finally { a.cleanup() }
  })

  it('literal large-file scanning keeps the host responsive', async () => {
    const a = area()
    try {
      const path = a.put('large.txt', 'x'.repeat(4 * 1024 * 1024))
      let beats = 0
      const timer = setInterval(() => beats++, 5)
      try {
        const r = await sliceRead(path, { find: 'needle', searchBudgetMs: 5000 })
        assert.equal(r.searchStatus, 'not_found'); assert.equal(r.searchComplete, true)
        assert.equal(r.scannedBytes, 4 * 1024 * 1024); assert.ok(beats > 2)
      } finally { clearInterval(timer) }
    } finally { a.cleanup() }
  })

  it('actual tool render continuation preserves root and follows startBytes across paths with spaces', async () => {
    const a = area()
    const p = plugin(a.root, a.cache)
    try {
      a.put('with spaces.txt', 'NEEDLEabcdefghijk')
      const tool = p.tools.project_slice_read
      const first = await call(tool, { path: 'with spaces.txt', find: 'NEEDLE', contextBefore: 0, lengthBytes: 6 })
      const rendered = tool.output!.render!({ path: 'with spaces.txt', find: 'NEEDLE' }, first) as any
      const renderedText = Array.isArray(rendered) ? rendered.map((b: any) => b.text ?? '').join('\n')
        : typeof rendered === 'string' ? rendered : JSON.stringify(rendered)
      assert.match(renderedText, /find@byte=0/)
      const pointer = renderedText.match(/project_slice_read\s+(\{[^\n]*?\})/)
      assert.ok(pointer, `missing unambiguous JSON continuation: ${renderedText}`)
      const nextArgs = JSON.parse(pointer[1])
      assert.equal(nextArgs.root, a.root); assert.equal(nextArgs.path, 'with spaces.txt')
      assert.equal(nextArgs.startBytes, 6); assert.equal(nextArgs.find, undefined)
      const second = await call(tool, nextArgs)
      assert.equal(second.snippet, 'abcdef'); assert.equal(second.byteOffset, 6)
    } finally { await p.dispose(); a.cleanup() }
  })
})
