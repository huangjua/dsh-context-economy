import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { scanJsonKeys, JSON_LIMITS } from '../src/json.js'

function area() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-json-'))
  const path = join(root, 'fixture.json')
  return { path, put: (text: string | Buffer) => writeFileSync(path, text), clean: () => rmSync(root, { recursive: true, force: true }) }
}

it('JSON pages preserve duplicate/escaped/Chinese keys and exact value byte pointers without rescanning prior pages', async () => {
  const a = area()
  try {
    const pairs = ['"中文":"emoji 😀"', '"escape\\n\\u4e2d":{"arr":[true,false,null,-0.2e+3,"\\t"]}', '"duplicate":1', '"duplicate":2',
      ...Array.from({ length: 20 }, (_, i) => `"k${i}":${i}`)]
    const input = '{' + pairs.join(',') + '} \n\r\t'
    a.put(input)
    const bytes = Buffer.from(input)
    const all: Array<{ key: string; byteStart: number; byteEnd: number; preview: string }> = []
    let cursor: string | undefined, previousBoundary = 0, scanned = 0
    do {
      const page = await scanJsonKeys(a.path, { limit: 3, cursor })
      assert.equal(page.error, undefined)
      assert.ok(page.entries.length <= 3)
      assert.equal(page.scanStartByte, previousBoundary)
      scanned += page.scannedBytes
      for (const e of page.entries) {
        assert.equal(e.preview, bytes.subarray(e.byteStart, e.byteEnd).toString('utf8'))
        assert.doesNotThrow(() => JSON.parse(bytes.subarray(e.byteStart, e.byteEnd).toString('utf8')))
      }
      all.push(...page.entries)
      if (page.hasMore) {
        assert.equal(page.validation, 'incomplete'); assert.equal(page.totalKeysKnown, false)
        assert.equal('totalKeys' in page, false); assert.ok(page.nextCursor)
        previousBoundary = page.scanEndByte
      } else {
        assert.equal(page.validation, 'complete'); assert.equal(page.totalKeysKnown, true)
        assert.equal(page.totalKeys, pairs.length)
      }
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(scanned, bytes.length)
    assert.deepEqual(all.map(e => e.key), ['中文', 'escape\n中', 'duplicate', 'duplicate', ...Array.from({ length: 20 }, (_, i) => `k${i}`)])
    assert.equal(all[0].preview, '"emoji 😀"')
    const parsed = Object.fromEntries(all.map(e => [e.key, JSON.parse(bytes.subarray(e.byteStart, e.byteEnd).toString('utf8'))]))
    assert.deepEqual(parsed, JSON.parse(input))
  } finally { a.clean() }
})

it('empty objects and nested JSON grammar are fully validated; arrays/primitives have explicit diagnostics', async () => {
  const a = area()
  try {
    for (const input of ['{}', '{ \n }', '{"a":{"b":[],"c":{},"d":[[1],{"x":"\\uD83D\\uDE00"}]}}']) {
      a.put(input); const r = await scanJsonKeys(a.path)
      assert.equal(r.validation, 'complete', input); assert.equal(r.hasMore, false); assert.equal(r.error, undefined, input)
    }
    for (const input of ['[1,true,{"x":null}]', '"中文"', '-1.23e+2', 'null', 'true', 'false']) {
      a.put(input); const r = await scanJsonKeys(a.path)
      assert.equal(r.validation, 'complete', input); assert.equal(r.diagnosticCode, 'unsupported_top_level')
      assert.equal(r.totalKeysKnown, false); assert.equal(r.entries.length, 0)
      assert.equal(r.topLevel, input[0] === '[' ? 'array' : 'primitive')
      if (input === '"中文"') assert.equal(r.topPreview, input)
    }
  } finally { a.clean() }
})

it('rejects missing commas/colons, malformed nesting, escapes, numbers/literals, trailing garbage and unclosed JSON', async () => {
  const a = area()
  try {
    const invalid = ['', '{"a":1 "b":2}', '{"a":tru}', '{"a":1,}', '{"a":[1}}', '{"a":1', '{"a" 1}',
      '{"a":}', '{"a":"\\q"}', '{"a":"\\uZZZZ"}', '{"a":"unfinished}', '{"a":01}', '{"a":1.}',
      '{"a":-}', '{"a":1e}', '{"a":1e+}', '{"a":NaN}', '{"a":truefalse}', '{"a":[1,]}', '{"a":{"x":1,}}',
      '{} garbage', '[]{}', '{"a":"line\nbreak"}', '{"a":+1}', '{"a":.1}', '[', 'falseX', '0x1', '00', 'null null']
    for (const input of invalid) {
      a.put(input); const r = await scanJsonKeys(a.path)
      assert.equal(r.validation, 'invalid', input); assert.ok(r.error, input); assert.equal(r.hasMore, false, input)
      assert.equal(r.totalKeysKnown, false, input)
    }
    for (const bytes of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe4, 0x22]]) {
      a.put(Buffer.concat([Buffer.from('{"a":"'), Buffer.from(bytes), Buffer.from('"}')]))
      assert.equal((await scanJsonKeys(a.path)).validation, 'invalid')
    }
  } finally { a.clean() }
})

it('last page validates closure and trailing bytes, including a trailing comma deferred across pages', async () => {
  const a = area()
  try {
    for (const input of ['{"a":1,"b":2,}', '{"a":1,"b":2}tail', '{"a":1,"b":2']) {
      a.put(input)
      const first = await scanJsonKeys(a.path, { limit: 1 })
      assert.equal(first.validation, 'incomplete'); assert.ok(first.nextCursor)
      let r = await scanJsonKeys(a.path, { limit: 1, cursor: first.nextCursor })
      if (r.nextCursor) r = await scanJsonKeys(a.path, { limit: 1, cursor: r.nextCursor })
      assert.equal(r.validation, 'invalid', input); assert.equal(r.hasMore, false)
    }
    a.put('{"a":1,')
    const eof = await scanJsonKeys(a.path, { limit: 1 })
    assert.equal(eof.validation, 'invalid'); assert.equal(eof.nextCursor, undefined)
  } finally { a.clean() }
})

it('chunk boundaries preserve UTF-8, escapes, numbers and nested parser state', async () => {
  const a = area()
  try {
    for (const suffix of ['中文😀', '\\u4e2d', '\\"escaped', '\\\\']) {
      // Place the UTF-8/escape sequence across the reader\'s 64 KiB refill boundary.
      for (const n of [65524, 65525, 65526, 65527, 65528, 65529]) {
        const input = '{"a":"' + 'x'.repeat(n) + suffix + '","b":-1.2e+30}'
        assert.doesNotThrow(() => JSON.parse(input))
        a.put(input); const r = await scanJsonKeys(a.path, { maxTimeMs: 10000 })
        assert.equal(r.validation, 'complete', `${suffix} at ${n}`)
        assert.equal(r.entries[0].byteEnd, Buffer.byteLength(input.slice(0, input.indexOf(',"b"'))))
        assert.equal(r.entries[1].preview, '-1.2e+30')
      }
    }
  } finally { a.clean() }
})

it('deterministic JSON.parse differential samples cover valid values and malformed mutations', async () => {
  const a = area()
  try {
    let seed = 12851
    const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
    const value = (depth: number): unknown => {
      const kind = next(depth > 3 ? 4 : 6)
      if (kind === 0) return null
      if (kind === 1) return next(2) === 0
      if (kind === 2) return (next(10000) - 5000) / 100
      if (kind === 3) return ['中😀', '\\n"\t', '', 'ASCII'][next(4)]
      if (kind === 4) return Array.from({ length: next(4) }, () => value(depth + 1))
      return Object.fromEntries(Array.from({ length: next(4) }, (_, i) => ['k' + i, value(depth + 1)]))
    }
    for (let i = 0; i < 80; i++) {
      const valid = JSON.stringify({ a: value(0), b: value(0), c: value(0) })
      const samples = [valid, valid.slice(0, -1), valid + 'x', valid.replace(':', ''), valid.replace(',', ',,')]
      for (const input of samples) {
        let validJson = true
        try { JSON.parse(input) } catch { validJson = false }
        a.put(input); const r = await scanJsonKeys(a.path)
        assert.equal(r.validation, validJson ? 'complete' : 'invalid', input)
      }
    }
  } finally { a.clean() }
})

it('cursor binds normalized path, scanner and file fingerprint; malformed continuations are rejected', async () => {
  const a = area()
  try {
    a.put('{"a":1,"b":2}')
    const r = await scanJsonKeys(a.path, { limit: 1 }); assert.ok(r.nextCursor)
    for (const cursor of ['', 'garbage', r.nextCursor!.slice(0, -2), 'a'.repeat(9000)]) {
      if (cursor) await assert.rejects(scanJsonKeys(a.path, { cursor }), /invalid_cursor/)
    }
    const forged = JSON.parse(Buffer.from(r.nextCursor!, 'base64url').toString('utf8'))
    const payload = JSON.parse(forged.payload); payload.count = 7
    forged.payload = JSON.stringify(payload)
    forged.checksum = createHash('sha256').update('dsh-json-cursor-v1\0' + forged.payload).digest('hex')
    await assert.rejects(scanJsonKeys(a.path, { cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') }), /invalid_cursor/)
    const lifetime = await scanJsonKeys(a.path, { limit: 1, cursorSecret: 'plugin-lifetime-a' })
    assert.equal((await scanJsonKeys(a.path, { cursor: lifetime.nextCursor, cursorSecret: 'plugin-lifetime-a' })).validation, 'complete')
    await assert.rejects(scanJsonKeys(a.path, { cursor: lifetime.nextCursor, cursorSecret: 'plugin-lifetime-b' }), /invalid_cursor/)
    const other = join(a.path, '..', 'other.json'); writeFileSync(other, readFileSync(a.path))
    await assert.rejects(scanJsonKeys(other, { cursor: r.nextCursor }), /invalid_cursor/)
    a.put('{"a":1,"b":3}')
    await assert.rejects(scanJsonKeys(a.path, { cursor: r.nextCursor }), /invalid_cursor/)
  } finally { a.clean() }
})

it('long strings, key/depth/output/scan/time budgets and cancellation never issue a fake infinite retry cursor', async () => {
  const a = area()
  try {
    a.put(JSON.stringify({ long: '中😀'.repeat(5000) }))
    const long = await scanJsonKeys(a.path, { maxPreview: 17 })
    assert.equal(long.validation, 'complete'); assert.ok(long.entries[0].preview.endsWith('…'))
    assert.ok(long.entries[0].preview.length <= 18); assert.equal(long.entries[0].byteEnd, readFileSync(a.path).length - 1)
    for (const opts of [{ maxScanBytes: 64 }, { maxKeyBytes: 2 }, { maxOutputBytes: 10 }]) {
      const r = await scanJsonKeys(a.path, opts)
      assert.equal(r.validation, 'budget_exhausted'); assert.equal(r.nextCursor, undefined); assert.equal(r.hasMore, false)
      assert.ok(r.resumeByteOffset !== undefined)
    }
    const bytes = await scanJsonKeys(a.path, { maxScanBytes: 64 })
    assert.equal(bytes.scannedBytes, 64); assert.equal(bytes.valueByteStart, Buffer.byteLength('{"long":'))
    assert.equal(bytes.readBytes, 64)
    a.put('{"first":1,"long":"' + 'x'.repeat(200) + '"}')
    const partial = await scanJsonKeys(a.path, { limit: 40, maxScanBytes: 64 })
    assert.equal(partial.entries.length, 1); assert.equal(partial.entries[0].key, 'first')
    assert.equal(partial.validation, 'budget_exhausted'); assert.equal(partial.nextCursor, undefined)
    assert.equal(partial.valueByteStart, Buffer.byteLength('{"first":1,"long":'))
    a.put('{"a":' + '['.repeat(8) + '0' + ']'.repeat(8) + '}')
    assert.equal((await scanJsonKeys(a.path, { maxDepth: 4 })).diagnosticCode, 'depth_budget_exhausted')
    a.put(JSON.stringify({ a: 'x'.repeat(5_000_000) }))
    const time = await scanJsonKeys(a.path, { maxTimeMs: 1 })
    assert.equal(time.validation, 'budget_exhausted'); assert.equal(time.diagnosticCode, 'time_budget_exhausted')
    const cancelled = new AbortController(); cancelled.abort()
    assert.equal((await scanJsonKeys(a.path, { signal: cancelled.signal })).validation, 'cancelled')
    const saved = readFileSync(a.path)
    a.put('')
    assert.equal((await scanJsonKeys(a.path, { signal: cancelled.signal })).validation, 'cancelled')
    a.put(saved)
    const active = new AbortController(); const timer = setTimeout(() => active.abort(), 1)
    try {
      assert.equal((await scanJsonKeys(a.path, { signal: active.signal })).validation, 'cancelled')
    } finally { clearTimeout(timer) }
    await assert.rejects(scanJsonKeys(a.path, { limit: 0 }), /invalid_limit/)
    await assert.rejects(scanJsonKeys(a.path, { limit: JSON_LIMITS.maxLimit + 1 }), /invalid_limit/)
  } finally { a.clean() }
})

it('output budget produces reachable continuation pages and bounds serialized page size', async () => {
  const a = area()
  try {
    a.put(JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}` + '中'.repeat(100), '😀'.repeat(100)]))))
    let cursor: string | undefined; const keys: string[] = []
    do {
      const r = await scanJsonKeys(a.path, { limit: 20, maxOutputBytes: 9500, cursor })
      assert.equal(r.error, undefined)
      assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 9500)
      assert.ok(r.entries.length > 0)
      keys.push(...r.entries.map(e => e.key)); cursor = r.nextCursor
    } while (cursor)
    assert.deepEqual(keys, Object.keys(JSON.parse(readFileSync(a.path, 'utf8'))))
  } finally { a.clean() }
})

it('a large scan yields to the main event loop and only retains the requested page', async () => {
  const a = area()
  try {
    a.put(JSON.stringify({ a: 'x'.repeat(3_000_000), b: 1 }))
    let pulses = 0; const timer = setInterval(() => pulses++, 1)
    try {
      const r = await scanJsonKeys(a.path, { limit: 1, maxTimeMs: 10000 })
      assert.equal(r.validation, 'incomplete'); assert.equal(r.entries.length, 1)
      assert.ok(pulses > 0, 'timer must run during byte scanning')
    } finally { clearInterval(timer) }
  } finally { a.clean() }
})
