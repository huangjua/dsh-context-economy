import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { validateJsonSchemaValue, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { ProjectIndexer } from '../src/core.js'
import { wrapMeasured, SavingsLedger } from '../src/savings.js'
import { sliceDiagnostics } from '../src/slice.js'
import { options, area, plugin, call } from './helpers.js'

it('slice and JSON read a single file without creating/scanning a project index', async () => {
  const a = area(), p = plugin(a.root, a.cache)
  const original = ProjectIndexer.prototype.ensure
  ProjectIndexer.prototype.ensure = async () => { throw new Error('whole project scan must not run') }
  try {
    a.put('data.txt', 'abcdefgh')
    a.put('data.json', '{"one":1,"two":2}')
    assert.equal((await call(p.tools.project_slice_read, { path: 'data.txt' })).snippet, 'abcdefgh')
    assert.equal((await call(p.tools.project_json_read, { path: 'data.json' })).totalKeys, 2)
    assert.equal(readdirSync(a.cache).some((f) => f.startsWith('index-') || f === 'heal-history.jsonl'), false)
  } finally { ProjectIndexer.prototype.ensure = original; await p.dispose(); a.cleanup() }
})

it('all eight tools validate parameters, execute, satisfy DSH output schemas and render', async () => {
  const a = area(), p = plugin(a.root, a.cache, { savingsEnabled: true })
  try {
    a.put('a.ts', 'import { B } from "./b.ts"\nexport const A = B\n')
    a.put('b.ts', 'export const B = 1\n')
    a.put('data.json', '{"one":1,"two":2}')
    const args: Record<string, Record<string, unknown>> = {
      project_index_status: { refresh: true }, project_symbols_find: { name: 'A', ranking: true, boostFiles: ['a.ts'] },
      project_imports: { file: 'b.ts', direction: 'in' }, project_files: { pattern: '.ts' },
      project_slice_read: { path: 'a.ts' }, project_cost_probe: { symbol: 'A' },
      project_savings: {}, project_json_read: { path: 'data.json' },
    }
    assert.equal(Object.keys(p.tools).length, 8)
    for (const [name, parameters] of Object.entries(args)) {
      const tool = p.tools[name]
      assertSupportedJsonSchema(tool.output!.schema)
      const result = await call(tool, parameters)
      // The real registry detaches values to JSON before its output schema check.
      const detached = JSON.parse(JSON.stringify(result))
      assert.deepEqual(validateJsonSchemaValue(tool.output!.schema, detached), [], name)
      const rendered = tool.output!.render(parameters, detached)
      assert.ok(rendered.length > 0 && rendered.some((b) => b.type === 'text' && b.text.length > 0), name)
      await assert.rejects(call(tool, { ...parameters, root: 42 }), /invalid arguments/, name)
    }
    const s = await call(p.tools.project_index_status, {})
    assert.ok(s.verifiedAt >= s.updatedAt); assert.equal(s.pendingFiles, 0)
  } finally { await p.dispose(); a.cleanup() }
})

it('measurement wrapper preserves execution signal with ledger on and off', async () => {
  const a = area()
  try {
    const signal = new AbortController().signal
    for (const ledger of [null, new SavingsLedger(join(a.cache, 'measured.jsonl'), 20)]) {
      const wrapped = wrapMeasured('test', async (_args: unknown, exec?: { signal: AbortSignal }) => {
        assert.equal(exec?.signal, signal); return { ok: true }
      }, { ledger, rootOf: () => a.root, naiveBytes: () => 100 })
      assert.deepEqual(await wrapped({}, { signal }), { ok: true })
    }
  } finally { a.cleanup() }
})

it('large JSON and slice scans allow host heartbeats; cancellation/unload awaits reader cleanup', async () => {
  const a = area()
  a.put('large.json', '{' + Array.from({ length: 100000 }, (_, i) => `"k${i}":${i}`).join(',') + '}')
  a.put('large.txt', 'x'.repeat(8 * 1024 * 1024))
  const p = plugin(a.root, a.cache, { savingsEnabled: true })
  let beats = 0
  const timer = setInterval(() => { beats++ }, 5)
  try {
    const output = await call(p.tools.project_json_read, { path: 'large.json', limit: 2 })
    assert.equal(output.totalKeysKnown, false)
    assert.equal(output.totalKeys, undefined)
    assert.equal(output.returned, 2)
    assert.equal(output.hasMore, true)
    assert.ok(output.scannedBytes < 100)
    assert.ok(beats > 0)
    const c = new AbortController()
    const reading = call(p.tools.project_json_read, { path: 'large.json' }, c.signal)
    const rejected = assert.rejects(reading)
    await immediate(); c.abort(new Error('cancel JSON')); await rejected
    const searching = call(p.tools.project_slice_read, { path: 'large.txt', find: 'NEVER-HERE' })
    const unloading = assert.rejects(searching)
    await immediate(); await p.dispose(); await unloading
    assert.equal(sliceDiagnostics.activeWorkers, 0)
    // Existing committed data remains intact; the aborted tools do not produce index caches.
    assert.equal(readdirSync(a.cache).some((f) => f.startsWith('index-') || f.includes('.tmp')), false)
    assert.ok(readFileSync(join(a.cache, 'savings.jsonl'), 'utf8').includes('project_json_read'))
  } finally { clearInterval(timer); await p.dispose(); a.cleanup() }
})

it('rendered slice continuation reads the next page with root and paths containing spaces', async () => {
  const a = area(), p = plugin(a.root, a.cache)
  try {
    a.put('folder with spaces/file name.txt', 'abcdefghijk')
    const tool = p.tools.project_slice_read
    const args = { path: 'folder with spaces/file name.txt', lengthBytes: 4 }
    const first = await call(tool, args)
    const rendered = tool.output!.render(args, first).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    const continuation = rendered.split('\n').find((line) => line.startsWith('继续下一页：project_slice_read '))!
    const nextArgs = JSON.parse(continuation.slice('继续下一页：project_slice_read '.length))
    assert.equal(nextArgs.root, a.root); assert.equal(nextArgs.startBytes, 4)
    assert.equal(nextArgs.findFrom, undefined)
    const second = await call(tool, nextArgs)
    assert.equal(first.snippet, 'abcd'); assert.equal(second.snippet, 'efgh')
    assert.equal(second.byteOffset, first.nextByteOffset)
    assert.equal(Buffer.byteLength(second.snippet), second.lengthBytes)
    const searchArgs = { ...args, find: 'abc' }
    const found = await call(tool, searchArgs)
    const foundRender = tool.output!.render(searchArgs, found).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    assert.ok(foundRender.includes('find@byte=0'))
    const plain = await call(tool, { ...args, startBytes: 11 })
    assert.equal(plain.hitByteOffset, undefined)
    assert.equal(tool.output!.render(args, plain).some((b) => b.type === 'text' && b.text.includes('继续下一页')), false)
  } finally { await p.dispose(); a.cleanup() }
})

it('all JSON page entries are rendered and rendered cursor reaches every remaining key', async () => {
  const a = area(), p = plugin(a.root, a.cache)
  try {
    const keys = Array.from({ length: 20 }, (_, i) => `key-${i}`)
    a.put('data with spaces.json', JSON.stringify(Object.fromEntries(keys.map((key, i) => [key, { value: i }]))))
    const tool = p.tools.project_json_read
    let args: Record<string, unknown> = { path: 'data with spaces.json', limit: 14 }
    const seen: string[] = []
    for (let page = 0; page < 4; page++) {
      const output = await call(tool, args)
      assert.deepEqual(validateJsonSchemaValue(tool.output!.schema, JSON.parse(JSON.stringify(output))), [])
      const render = tool.output!.render(args, output).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      for (const e of output.entries) {
        assert.ok(render.includes(JSON.stringify(e.key)), e.key)
        seen.push(e.key)
        const value = await call(p.tools.project_slice_read, { root: output.root, path: output.path,
          startBytes: e.byteStart, lengthBytes: e.byteEnd - e.byteStart })
        assert.deepEqual(JSON.parse(value.snippet), { value: Number(e.key.slice(4)) })
      }
      if (!output.hasMore) {
        assert.equal(output.totalKeys, 20); assert.equal(output.validation, 'complete'); break
      }
      assert.equal(output.totalKeysKnown, false)
      const continuation = render.split('\n').find((line) => line.startsWith('继续下一页：project_json_read '))!
      args = JSON.parse(continuation.slice('继续下一页：project_json_read '.length))
    }
    assert.deepEqual(seen, keys)
  } finally { await p.dispose(); a.cleanup() }
})

it('JSON continuations survive per-call worker replacement but reject after plugin reload', async () => {
  const a = area()
  a.put('data.json', '{"one":1,"two":2}')
  let p = plugin(a.root, a.cache)
  try {
    const first = await call(p.tools.project_json_read, { path: 'data.json', limit: 1 })
    assert.equal((await call(p.tools.project_json_read, { path: 'data.json', cursor: first.nextCursor })).entries[0].key, 'two')
    await p.dispose()
    p = plugin(a.root, a.cache)
    await assert.rejects(call(p.tools.project_json_read, { path: 'data.json', cursor: first.nextCursor }), /invalid_cursor/)
    assert.equal((await call(p.tools.project_json_read, { path: 'data.json', limit: 1 })).entries[0].key, 'one')
  } finally { await p.dispose(); a.cleanup() }
})

it('JSON complete tool output and render remain bounded with long roots and large pages', async () => {
  const a = area(), p = plugin(a.root, a.cache)
  try {
    const path = a.put('budget.json', JSON.stringify(Object.fromEntries(Array.from({ length: 150 }, (_, i) =>
      [`key-${i}-` + '长'.repeat(530), 'x'.repeat(240)]))))
    const root = resolve(a.root, 'x'.repeat(800))
    const args = { root, path, limit: 1000 }
    const output = await call(p.tools.project_json_read, args)
    assert.ok(output.returned > 12 && output.returned < 150)
    assert.ok(output.nextCursor)
    assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 64 * 1024)
    const render = toolText(p.tools.project_json_read.output!.render(args, output))
    assert.ok(Buffer.byteLength(render) <= 64 * 1024)
    for (const e of output.entries) assert.ok(render.includes(JSON.stringify(e.key)))
    const next = await call(p.tools.project_json_read, { ...args, cursor: output.nextCursor })
    assert.equal(next.entries[0].key.startsWith(`key-${output.returned}-`), true)
    await assert.rejects(call(p.tools.project_json_read, { ...args, root: resolve(a.root, 'x'.repeat(1100)) }), /路径预算/)
  } finally { await p.dispose(); a.cleanup() }
})

function toolText(blocks: ReturnType<NonNullable<import('@deepseek-ai/dsh-tools').ToolDefinition['output']>['render']>): string {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}
