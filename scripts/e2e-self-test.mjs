// e2e self-test + cost probe for dsh-context-economy core
// 独立于 loader，用动态 import 正确加载 lib/core.js
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'

const PLUGIN = 'C:/Users/admin/.dsh/plugins-dev/dsh-context-economy'
const DEMO = 'C:/Users/admin/.dsh/plugins-dev/dsh-demo-project'
const coreUrl = 'file:///' + PLUGIN.replace(/\\/g, '/') + '/lib/core.js'

const { ProjectIndexer, sliceRead, estimateTokens } = await import(coreUrl)
const cache = join(homedir(), '.dsh', 'project-index')
const opts = { includeExts: ['.ts', '.js', '.py', '.md'], skipDirs: ['node_modules', '.git'], maxScanBytes: 512 * 1024, maxContextLen: 240 }

const idx = new ProjectIndexer(DEMO, cache, opts)
const rep = idx.ensure()

const L = []
const out = (s) => { L.push(s) }
out('=== dsh-context-economy e2e self-test (core only) ===')
out('root=' + DEMO)
out('INDEX files=' + rep.totalFiles + ' symbols=' + rep.symbols + ' imports=' + rep.imports)
out('status=' + JSON.stringify(idx.status))

// 符号查询 + 成本探针
out('')
out('-- symbol probe (pointer vs 朴素整文件基线, ~4字符/token 粗估) --')
for (const sym of ['add', 'mul', 'Calculator', 'run', 'Worker', 'shout', 'process', 'GREETING', 'Name']) {
  const r = idx.findSymbols(sym)
  const outChars = JSON.stringify(r.hits.map((h) => h.file + ':' + h.line + ' ' + h.name)).length
  const naive = r.matchedFileBytes
  const outTok = estimateTokens(outChars)
  const naiveTok = estimateTokens(naive)
  const saved = Math.max(0, naiveTok - outTok)
  const pct = naiveTok > 0 ? Math.round(Math.max(0, (naiveTok - outTok) / naiveTok) * 1000) / 10 : 0
  out([sym.padEnd(9), 'hits=' + String(r.hits.length).padStart(2), 'out=' + outChars + 'c/~' + outTok + 't', 'naive=' + naive + 'B/~' + naiveTok + 't', 'saved ~' + saved + 't (' + pct + '%)'].join('  '))
}

// import 边
out('')
out('-- import edges app.ts (out) --')
for (const e of idx.findImports('app.ts', 'out')) out(`  ${e.from}:${e.line} -> ${e.to}`)

// 切片
out('')
out('-- slice (find="Calculator" in app.ts) --')
const sl = sliceRead(join(DEMO, 'app.ts'), { find: 'Calculator', lengthBytes: 256 })
out(`  hitByte=${sl.hitByteOffset} len=${sl.lengthBytes} total=${sl.totalBytes} next=${sl.nextByteOffset}`)
out('  snippet=' + JSON.stringify(sl.snippet.slice(0, 120)))

out('')
out('E2E-SELF-TEST OK')

writeFileSync(join(DEMO, 'cost-probe.txt'), L.join('\n'), 'utf8')
console.log(L.join('\n'))
console.log('SAVED ' + join(DEMO, 'cost-probe.txt'))
