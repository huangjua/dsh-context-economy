import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  ProjectIndexer, buildGraph, extractImports, extractSymbols, pageRank, resolveSpecifier,
  type ImportEdge,
} from '../src/core.js'
import { area, options } from './helpers.js'

const allOptions = { ...options, includeExts: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.py', '.json'] }

it('symbol declaration lines respect blank lines, indentation, CRLF, multiline modifiers and the final line', () => {
  const text = '\r\n\r\n  export function Actual() {}\r\n\r\n\tclass Last {}'
  assert.deepEqual(extractSymbols(text, '.ts', 240).map((s) => [s.name, s.line]), [['Actual', 3], ['Last', 5]])
  assert.equal(extractSymbols('\nexport\n\nfunction Multiline() {}', '.ts', 240)[0].line, 4)
  for (const [ext, declaration] of [['.py', '  def Last(): pass'], ['.go', '\tfunc Last() {}'],
    ['.rs', '  pub fn Last() {}'], ['.unknown', '  function Last() {}']]) {
    assert.equal(extractSymbols('\r\n\r\n' + declaration, ext, 240)[0].line, 3, ext)
  }
})

it('imports/re-exports retain raw specifiers, actual declaration lines and complete final-line context', () => {
  const root = resolve('test-root')
  const text = '\r\n\r\n  import { B } from "./b"\r\n\r\n\texport { C } from "./c.js"\r\n' +
    'export * from "./star"\r\nexport * as ns from "./ns"\r\nconst lazy = import("./lazy"); const required = require("./required")'
  const edges = extractImports(text, root, 'a.ts', '.ts', 240)
  assert.deepEqual(edges.map((e) => [e.specifier, e.line]),
    [['./b', 3], ['./c.js', 5], ['./star', 6], ['./ns', 7], ['./lazy', 8], ['./required', 8]])
  assert.equal(edges.at(-1)!.context, 'const lazy = import("./lazy"); const required = require("./required")')
  assert.equal(extractImports('\n\nfrom .helper import Last', root, 'pkg/a.py', '.py', 240)[0].line, 3)
  assert.equal(extractImports('import "./last"', root, 'a.ts', '.ts', 240)[0].context, 'import "./last"')
  const multiline = extractImports('\nimport {\n  B,\n} from "./b"', root, 'a.ts', '.ts', 240)[0]
  assert.equal(multiline.line, 2)
  assert.equal(extractImports('export type { B } from "./b"', root, 'a.ts', '.ts', 240)[0].specifier, './b')
  assert.equal(extractImports('import "./spaced file "', root, 'a.ts', '.ts', 240)[0].specifier, './spaced file ')
})

it('relative resolution has deterministic extension substitution and index priority without prefix guesses', () => {
  const root = resolve('test-root')
  const files = ['b.js', 'b.ts', 'b.tsx', 'dir/index.js', 'dir/index.ts', 'm.mts', 'm.mjs', 'c.cts', 'c.cjs',
    'react.ts', 'prefix.extra.ts', 'dots.name/index.ts', '..local.ts']
  for (const order of [files, [...files].reverse()]) {
    const set = new Set(order)
    const r = (spec: string, from = 'a.ts') => resolveSpecifier(root, from, spec, set)
    for (const [spec, target] of [['./b', 'b.ts'], ['./b.ts', 'b.ts'], ['./b.js', 'b.ts'],
      ['./dir', 'dir/index.ts'], ['./m.mjs', 'm.mts'], ['./c.cjs', 'c.cts'], ['./..local.ts', '..local.ts'],
      ['./dots.name', 'dots.name/index.ts']]) {
      assert.deepEqual(r(spec), { specifier: spec, status: 'resolved', to: target, target }, spec)
    }
    assert.equal(r('./b.js', 'a.js').target, 'b.js', 'JS explicit extension preserves its own source')
    assert.equal(r('./prefix').status, 'unresolved', 'arbitrary dot-prefix is not an extension')
    assert.equal(r('react').status, 'external', 'bare package cannot acquire a same-named local file')
    assert.equal(r('node:fs').status, 'external')
    assert.equal(r('../outside').status, 'outside')
    assert.equal(r('@/b').status, 'unresolved')
    assert.equal(r('#internal').status, 'unresolved')
    assert.equal(r('./missing').status, 'unresolved')
  }
})

it('dollar import bindings retain every incoming graph edge and invalidate pre-H extraction caches', async () => {
  const a = area(), idx = new ProjectIndexer(a.root, a.cache, allOptions)
  try {
    const declarations = [
      'import $default from "./b.js"', 'import { $named } from "./b.js"',
      'import { normal as $local } from "./b.js"', 'import type { $Named } from "./b.js"',
      'import * as $namespace from "./b.js"',
    ]
    const source = '\r\n' + declarations.join('\r\n')
    assert.deepEqual(extractImports(source, a.root, 'a.ts', '.ts', 240).map(e => [e.specifier, e.line]),
      declarations.map((_, i) => ['./b.js', i + 2]))
    a.put('a.ts', source)
    a.put('b.ts', 'export const $named = 1; export const normal = 2; export default $named')
    await idx.ensure()
    const assertEdges = (index: ProjectIndexer) => {
      assert.deepEqual(index.findImports('a.ts', 'out').map(e => [e.target, e.status]),
        declarations.map(() => ['b.ts', 'resolved']))
      assert.equal(index.findImports('b.ts', 'in').length, declarations.length)
      assert.equal(index.graph!.indegree['b.ts'], declarations.length)
      assert.deepEqual(index.findOrphans(), [])
    }
    assertEdges(idx)
    const legacy = JSON.parse(readFileSync(idx.cacheFile, 'utf8'))
    legacy.configFingerprint = createHash('sha256').update(JSON.stringify({
      parser: 'lightweight-002-2-unified-imports', includeExts: [...allOptions.includeExts].sort(),
      skipDirs: [...allOptions.skipDirs].sort(), maxScanBytes: allOptions.maxScanBytes,
      maxContextLen: allOptions.maxContextLen,
    })).digest('hex')
    writeFileSync(idx.cacheFile, JSON.stringify(legacy))
    const reloaded = new ProjectIndexer(a.root, a.cache, allOptions)
    try {
      assert.equal((await reloaded.ensure()).rescannedFiles, 2, 'pre-H parser cache must reread unchanged source files')
      assertEdges(reloaded)
    } finally { await reloaded.dispose() }
  } finally { await idx.dispose(); a.cleanup() }
})

it('Python absolute and relative modules retain basic module/package resolution', () => {
  const root = resolve('test-root'), files = new Set(['math_utils.py', 'pkg/helper.py', 'shared.py', 'pkg/sub/__init__.py'])
  for (const [from, spec, expected] of [['main.py', 'math_utils', 'math_utils.py'],
    ['pkg/main.py', '.helper', 'pkg/helper.py'], ['pkg/main.py', '..shared', 'shared.py'],
    ['main.py', 'pkg.sub', 'pkg/sub/__init__.py']]) {
    assert.equal(resolveSpecifier(root, from, spec, files).target, expected)
  }
  assert.equal(resolveSpecifier(root, 'main.py', '..shared', files).status, 'outside')
  assert.equal(resolveSpecifier(root, 'pkg/main.py', '.', files).status, 'unresolved')
  assert.equal(resolveSpecifier(root, 'main.py', 'unknown_package', files).status, 'unresolved')
})

it('incoming/outgoing queries and graph degrees consume exactly the same project targets', async () => {
  const a = area()
  const idx = new ProjectIndexer(a.root, a.cache, allOptions)
  try {
    a.put('a.ts', 'import { B } from "./b"\nimport { C } from "./b.js"\nexport { B } from "./b.ts"\n' +
      'export * from "./dir"\nimport "react"\nimport "../outside"\nimport "./missing"')
    a.put('b.ts', 'export const B = 1')
    a.put('b.js', 'export const JS = 1')
    a.put('dir/index.ts', 'export const D = 1')
    a.put('react.ts', 'export const LocalReact = 1')
    a.put('prefix.extra.ts', 'export const Prefix = 1')
    a.put('unknown.ts', 'import "./prefix"')
    a.put('p.py', '\nfrom math_utils import add\n')
    a.put('math_utils.py', 'def add(): pass')
    await idx.ensure()
    const out = idx.findImports('a.ts', 'out')
    assert.equal(out.length, 7)
    assert.deepEqual(out.slice(0, 4).map((e) => e.target), ['b.ts', 'b.ts', 'b.ts', 'dir/index.ts'])
    assert.deepEqual(out.slice(4).map((e) => e.status), ['external', 'outside', 'unresolved'])
    for (const [file, degree] of Object.entries(idx.graph!.indegree)) {
      assert.equal(idx.findImports(file, 'in').length, degree, file)
    }
    assert.equal(idx.graph!.indegree['b.ts'], 3, 'degree counts each distinct reference edge, not unique source files')
    assert.equal(idx.findImports(join(a.root, 'b.ts'), 'in').length, 3)
    assert.deepEqual(idx.findImports('dir/../b.ts', 'in'), idx.findImports('b.ts', 'in'))
    assert.deepEqual(idx.findImports('.\\dir\\..\\b.ts', 'in'), idx.findImports('b.ts', 'in'))
    assert.deepEqual(idx.findImports(join(a.root, 'dir', '..', 'b.ts'), 'in'), idx.findImports('b.ts', 'in'))
    assert.deepEqual(idx.findImports('dir/../a.ts', 'out'), idx.findImports('a.ts', 'out'))
    assert.deepEqual(idx.findImports('../b.ts', 'in'), [], 'project-external query cannot become a local incoming edge')
    assert.deepEqual(idx.findImports(join(a.base, 'b.ts'), 'out'), [])
    assert.equal(idx.findImports('.\\dir\\index.ts', 'in').length, 1)
    assert.equal(idx.findImports('react.ts', 'in').length, 0)
    assert.equal(idx.findImports('math_utils.py', 'in').length, 1)
    assert.equal(idx.findOrphans().some((f) => f.file === 'unknown.ts'), false, 'unresolved outgoing reference is not a certain orphan')
    assert.equal(idx.findOrphans().some((f) => f.file === 'react.ts'), true)
  } finally { await idx.dispose(); a.cleanup() }
})

it('target additions/deletions re-resolve unchanged importing files and update import context', async () => {
  const a = area()
  const reads = new Map<string, number>()
  const idx = new ProjectIndexer(a.root, a.cache, allOptions, { readText: async (path) => {
    reads.set(path, (reads.get(path) ?? 0) + 1); return readFile(path, 'utf8')
  } })
  try {
    const importer = a.put('a.ts', '\nimport "./b"')
    await idx.ensure()
    assert.equal(idx.findImports('a.ts', 'out')[0].status, 'unresolved')
    a.put('b.js', 'export const JS = 1'); await idx.ensure()
    assert.equal(idx.findImports('b.js', 'in').length, 1)
    a.put('b.ts', 'export const TS = 1'); await idx.ensure()
    assert.equal(idx.findImports('b.ts', 'in').length, 1)
    assert.equal(idx.findImports('b.js', 'in').length, 0)
    assert.match((idx as any).fileContext('a.ts'), /a\.ts:2 → b\.ts/)
    unlinkSync(join(a.root, 'b.ts')); await idx.ensure()
    assert.equal(idx.findImports('a.ts', 'out')[0].target, 'b.js')
    unlinkSync(join(a.root, 'b.js')); await idx.ensure()
    const missing = idx.findImports('a.ts', 'out')[0]
    assert.equal(missing.specifier, './b'); assert.equal(missing.status, 'unresolved'); assert.equal(missing.target, undefined)
    assert.equal(idx.findOrphans().some((f) => f.file === 'a.ts'), false)
    a.put('b/index.ts', 'export const Index = 1'); await idx.ensure()
    assert.equal(idx.findImports('b/index.ts', 'in').length, 1)
    assert.equal(reads.get(importer), 1, 'only added/changed files are reread')
    const builds = idx.diagnostics.contextBuilds
    await idx.ensure(); assert.equal(idx.diagnostics.contextBuilds, builds)
  } finally { await idx.dispose(); a.cleanup() }
})

it('PageRank preserves duplicate-edge weights and keeps unresolved endpoints out of the graph', () => {
  const edge = (from: string, to: string, line: number): ImportEdge => ({ from, to, specifier: './' + to,
    status: 'resolved', target: to, line, context: '' })
  const imports = [edge('a.ts', 'b.ts', 1), edge('a.ts', 'b.ts', 2), edge('a.ts', 'c.ts', 3),
    { from: 'u.ts', to: 'b', specifier: 'b', status: 'external' as const, line: 1, context: '' }]
  const nodes = ['a.ts', 'b.ts', 'c.ts', 'u.ts', 'z.ts']
  const graph = buildGraph(imports, nodes)
  assert.deepEqual([...graph.ranks], [...pageRank(nodes, imports.slice(0, 3)).ranks])
  assert.equal(graph.indegree.get('b.ts'), 2)
  assert.deepEqual(graph.orphans, ['z.ts'])
  assert.deepEqual([...buildGraph(imports, []).ranks], [])
})

it('parser changes and invalid resolved-import cache fields rebuild source-derived rows', async () => {
  const a = area()
  const seed = new ProjectIndexer(a.root, a.cache, allOptions)
  try {
    a.put('a.ts', 'import "./b"'); a.put('b.ts', '\n\nexport const B = 1')
    await seed.ensure()
    const valid = JSON.parse(readFileSync(seed.cacheFile, 'utf8'))
    const mutations: Array<(v: any) => void> = [
      (v) => { delete v.imports[0].specifier }, (v) => { v.imports[0].status = 'guessed' },
      (v) => { v.imports[0].target = 'absent.ts' }, (v) => { v.imports[0].to = './b' },
      (v) => { v.imports[0].status = 'unresolved' },
      (v) => { v.configFingerprint = createHash('sha256').update(JSON.stringify({ parser: 'lightweight-002-1',
        includeExts: [...allOptions.includeExts].sort(), skipDirs: [...allOptions.skipDirs].sort(),
        maxScanBytes: allOptions.maxScanBytes, maxContextLen: allOptions.maxContextLen })).digest('hex') },
    ]
    for (const mutate of mutations) {
      const bad = structuredClone(valid); mutate(bad); writeFileSync(seed.cacheFile, JSON.stringify(bad))
      const recovered = new ProjectIndexer(a.root, a.cache, allOptions)
      try {
        assert.equal((await recovered.ensure()).rescannedFiles, 2)
        assert.equal(recovered.findImports('b.ts', 'in').length, 1)
        assert.equal(recovered.findSymbols('B').hits[0].line, 3)
      } finally { await recovered.dispose() }
    }
  } finally { await seed.dispose(); a.cleanup() }
})

it('graph-demo ranks, hotspots, orphans, symbol ordering and boostFiles retain their contracts', async () => {
  const a = area(), idx = new ProjectIndexer(a.root, a.cache, allOptions)
  try {
    const fixture = join(process.cwd(), 'fixtures', 'graph-demo')
    for (const name of readdirSync(fixture)) a.put(name, readFileSync(join(fixture, name), 'utf8'))
    await idx.ensure()
    const nodes = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'hub.ts']
    const edges = [{ from: 'a.ts', to: 'b.ts' }, { from: 'a.ts', to: 'hub.ts' },
      { from: 'b.ts', to: 'c.ts' }, { from: 'c.ts', to: 'a.ts' }, { from: 'd.ts', to: 'hub.ts' }]
    for (const [file, rank] of pageRank(nodes, edges).ranks) assert.ok(Math.abs(idx.graph!.ranks[file] - rank) < 1e-12)
    assert.deepEqual(idx.findHotspots().map((r) => [r.file, r.indegree]), [['hub.ts', 2], ['a.ts', 1], ['c.ts', 1], ['b.ts', 1]])
    assert.deepEqual(idx.findOrphans().map((r) => r.file), ['e.ts'])
    assert.deepEqual(idx.findSymbols('common').hits.map((s) => s.file), ['a.ts', 'b.ts', 'c.ts'])
    assert.deepEqual(idx.findSymbols('common', undefined, true).hits.map((s) => s.file), ['a.ts', 'c.ts', 'b.ts'])
    const boosted = idx.findSymbols('common', undefined, true, ['b.ts']).hits
    assert.equal(boosted[0].file, 'b.ts'); assert.equal(boosted.length, 3)
  } finally { await idx.dispose(); a.cleanup() }
})
