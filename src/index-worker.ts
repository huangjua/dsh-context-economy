/** CPU-heavy cache parsing, extraction and PageRank run off the host event loop. No writes here. */
import { parentPort } from 'node:worker_threads'
import { buildGraph, extractImports, extractSymbols } from './core.js'
import { scanJsonKeys } from './json.js'
import { loadIndex, encodeIndex } from './cache-format.js'

parentPort!.on('message', async ({ kind, payload }) => {
  try {
    let value: unknown
    switch (kind) {
      case 'load': value = loadIndex(payload.cacheFile, payload.root, payload.opts, payload.verificationFile); break
      case 'encode': value = encodeIndex(payload); break
      case 'json': value = await scanJsonKeys(payload.path, payload.opts); break
      case 'extract': value = payload.files.map((f: { text: string; rel: string; ext: string }) => ({
        rel: f.rel,
        symbols: extractSymbols(f.text, f.ext, payload.maxContextLen),
        imports: extractImports(f.text, payload.root, f.rel, f.ext, payload.maxContextLen),
      })); break
      case 'graph': {
        const g = buildGraph(payload.imports, payload.files)
        value = { indegree: Object.fromEntries(g.indegree), ranks: Object.fromEntries(g.ranks), orphans: g.orphans }
        break
      }
      default: throw new Error('unknown index worker job')
    }
    parentPort!.postMessage({ value })
  } catch (e) {
    parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) })
  }
})
