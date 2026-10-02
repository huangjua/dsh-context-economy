import { it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hashArgs, SavingsLedger, wrapMeasured } from '../src/savings.js'
import { area, plugin, call } from './helpers.js'

it('stable hashes sort nested object keys and preserve array order', () => {
  assert.equal(hashArgs('t', 'r', { a: 1, nested: { z: 2, b: 3 }, list: [1, 2] }),
    hashArgs('t', 'r', { list: [1, 2], nested: { b: 3, z: 2 }, a: 1 }))
  assert.notEqual(hashArgs('t', 'r', { list: [1, 2] }), hashArgs('t', 'r', { list: [2, 1] }))
})

it('disabled measurement never serializes args/results or resolves accounting callbacks', async () => {
  const a = area()
  try {
    const result = { toJSON() { throw new Error('must not stringify') } }
    const args = { toJSON() { throw new Error('must not stringify args') } }
    const unexpected = () => { throw new Error('accounting is disabled') }
    const wrapped = wrapMeasured('test', async () => result, {
      ledger: null, rootOf: unexpected, naiveBytes: unexpected, normalizeArgs: unexpected,
    })
    assert.equal(await wrapped(args), result)
    assert.equal(existsSync(join(a.cache, 'savings.jsonl')), false)
  } finally { a.cleanup() }
})

it('default root is identical for symbols, slice, JSON and failures; JSON filtering works', async () => {
  const a = area(), p = plugin(a.root, a.cache, { savingsEnabled: true })
  try {
    a.put('a.ts', 'export const A = 1')
    a.put('data.json', '{"first":1}')
    await call(p.tools.project_symbols_find, { name: 'A' })
    await call(p.tools.project_slice_read, { path: 'a.ts' })
    await call(p.tools.project_json_read, { path: 'data.json' })
    await assert.rejects(call(p.tools.project_slice_read, { path: 'missing.txt' }))
    await assert.rejects(call(p.tools.project_json_read, { path: 'missing.json' }))
    const s = await call(p.tools.project_savings, { root: a.root })
    assert.equal(s.totalRows, 5); assert.equal(s.aggregate.failures, 2)
    assert.deepEqual(s.byRoot.map((g: { key: string }) => g.key), [resolve(a.root)])
    const json = await call(p.tools.project_savings, { root: a.root, tool: 'project_json_read' })
    assert.equal(json.totalRows, 2); assert.equal(json.aggregate.failures, 1)
    assert.ok(p.tools.project_savings.description.includes('project_json_read'))
  } finally { await p.dispose(); a.cleanup() }
})

it('omitted defaults, normalized paths and property order share effective call identity', async () => {
  const a = area(), p = plugin(a.root, a.cache, { savingsEnabled: true, maxHits: 2 })
  try {
    a.put('a.ts', 'import { B } from "./b.ts"\nexport const A = B')
    a.put('b.ts', 'export const B = 1')
    a.put('data.json', '{"first":1}')
    await call(p.tools.project_symbols_find, { name: 'A' })
    await call(p.tools.project_symbols_find, { ranking: false, limit: 2, name: 'A', root: join(a.root, '.') })
    await call(p.tools.project_slice_read, { path: 'a.ts' })
    await call(p.tools.project_slice_read, { re: false, startBytes: 0, mode: 'window', lengthBytes: 4096,
      root: a.root, path: join(a.root, 'a.ts'), findFrom: 123, contextBefore: 99 })
    await call(p.tools.project_json_read, { path: 'data.json' })
    await call(p.tools.project_json_read, { limit: 2, path: join(a.root, 'data.json'), root: a.root })
    const incoming = await call(p.tools.project_imports, { file: 'b.ts' })
    const equivalent = await call(p.tools.project_imports, { direction: 'in', limit: 2,
      root: a.root, file: 'unused/../b.ts' })
    assert.deepEqual(incoming.edges, equivalent.edges)
    const rows = readFileSync(join(a.cache, 'savings.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    for (let i = 0; i < rows.length; i += 2) assert.equal(rows[i].argsHash, rows[i + 1].argsHash)
    const s = await call(p.tools.project_savings, {})
    assert.equal(s.aggregate.dupCalls, 4)
  } finally { await p.dispose(); a.cleanup() }
})

it('ledger writes failing do not turn a successful read into a failure', async () => {
  const a = area()
  mkdirSync(join(a.cache, 'savings.jsonl'))
  const p = plugin(a.root, a.cache, { savingsEnabled: true })
  try {
    a.put('a.txt', 'successful')
    assert.equal((await call(p.tools.project_slice_read, { path: 'a.txt' })).snippet, 'successful')
  } finally { await p.dispose(); a.cleanup() }
})

it('maxHits is a default, explicit larger limits remain valid; invalid limits are rejected', async () => {
  const a = area(), p = plugin(a.root, a.cache, { maxHits: 1 })
  try {
    a.put('a.ts', Array.from({ length: 5 }, (_, i) => `export const Item${i} = ${i}`).join('\n'))
    a.put('data.json', '{"one":1,"two":2,"three":3}')
    assert.equal((await call(p.tools.project_symbols_find, { name: 'Item' })).returned, 1)
    assert.equal((await call(p.tools.project_symbols_find, { name: 'Item', limit: 5 })).returned, 5)
    assert.equal((await call(p.tools.project_json_read, { path: 'data.json', limit: 3 })).returned, 3)
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(call(p.tools.project_symbols_find, { name: 'Item', limit: value }))
      await assert.rejects(call(p.tools.project_json_read, { path: 'data.json', limit: value }))
    }
    await assert.rejects(call(p.tools.project_json_read, { path: 'data.json', limit: 1001 }), /硬上限/)
  } finally { await p.dispose(); a.cleanup() }
})

it('ledger root query normalizes equivalent absolute root paths', () => {
  const a = area()
  try {
    const ledger = new SavingsLedger(join(a.cache, 'rows.jsonl'), 10)
    ledger.record({ root: a.root, tool: 'project_json_read', argsHash: 'a', chars: 1, naiveBytes: 10,
      savedTokens: 1, failed: false })
    assert.equal(ledger.query({ root: join(a.root, 'sub', '..') }).totalRows, 1)
  } finally { a.cleanup() }
})
