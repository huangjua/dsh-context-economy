import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  emptyState, INDEX_VERSION, indexFingerprint,
  type IndexOptions, type IndexState, type PersistedIndexState, type SymbolRow,
} from './core.js'

const record = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v)
const relFile = (v: unknown): v is string => typeof v === 'string' && v.length > 0 &&
  !isAbsolute(v) && !v.includes('\\') && !v.includes('\0') &&
  !v.split('/').some((p) => p === '..' || p === '.' || p === '')

/** Validate the whole derived cache before touching row fields. Never retain fingerprints of bad rows. */
export function decodeIndex(raw: unknown, root: string, opts: IndexOptions): {
  state: IndexState; corrupt: boolean; reason: string
} {
  const invalid = (reason: string, corrupt = true) => ({ state: emptyState(root, opts), corrupt, reason })
  if (!record(raw)) return invalid('invalid cache object')
  if (raw.version !== INDEX_VERSION) return invalid('cache version changed', false)
  if (typeof raw.root !== 'string' || resolve(raw.root) !== root) return invalid('wrong cache root')
  if (raw.configFingerprint !== indexFingerprint(opts)) return invalid('extraction configuration changed', false)
  if (!integer(raw.updatedAt) || !integer(raw.verifiedAt) || !record(raw.files) ||
      !Array.isArray(raw.fileList) || !Array.isArray(raw.symbols) || !Array.isArray(raw.imports)) {
    return invalid('invalid cache structure')
  }
  const names = Object.keys(raw.files)
  const files = new Set(names)
  if (!names.every((f) => relFile(f) && record(raw.files[f]) &&
    finite(raw.files[f].mtime) && integer(raw.files[f].size) &&
    (raw.files[f].pending === undefined || typeof raw.files[f].pending === 'boolean'))) return invalid('invalid file metadata')
  if (raw.fileList.length !== names.length || new Set(raw.fileList).size !== names.length ||
      !raw.fileList.every((f: unknown) => relFile(f) && files.has(f))) return invalid('invalid fileList')
  if (!raw.symbols.every((r: unknown) => record(r) && typeof r.n === 'string' && r.n.length > 0 &&
      integer(r.f) && r.f < raw.fileList.length && integer(r.l) && r.l > 0 &&
      typeof r.k === 'string' && typeof r.c === 'string')) return invalid('invalid symbol row')
  if (!raw.imports.every((e: unknown) => record(e) && relFile(e.from) && files.has(e.from) &&
      typeof e.to === 'string' && e.to.length > 0 && integer(e.line) && e.line > 0 &&
      typeof e.specifier === 'string' && e.specifier.length > 0 &&
      ['resolved', 'external', 'outside', 'unresolved'].includes(e.status) &&
      (e.status === 'resolved'
        ? relFile(e.target) && files.has(e.target) && e.to === e.target
        : e.target === undefined && e.to === e.specifier) &&
      typeof e.context === 'string')) return invalid('invalid import row')
  const g = raw.graph
  if (g !== null) {
    if (!record(g) || !record(g.indegree) || !record(g.ranks) || !Array.isArray(g.orphans) ||
      Object.keys(g.indegree).length !== files.size || Object.keys(g.ranks).length !== files.size ||
      !names.every((f) => integer(g.indegree[f]) && finite(g.ranks[f])) ||
      new Set(g.orphans).size !== g.orphans.length || !g.orphans.every((f: unknown) => typeof f === 'string' && files.has(f))) {
      return invalid('invalid graph')
    }
  }
  // Undefined graph is invalid (rather than silently supplying null).
  if (g === undefined) return invalid('missing graph')
  const s = raw as PersistedIndexState
  return {
    state: { ...s, symbols: s.symbols.map((r) => ({ name: r.n, file: s.fileList[r.f], line: r.l, kind: r.k, context: r.c })) },
    corrupt: false, reason: '',
  }
}

export function loadIndex(cacheFile: string, root: string, opts: IndexOptions, verificationFile?: string) {
  try {
    const decoded = decodeIndex(JSON.parse(readFileSync(cacheFile, 'utf8')), root, opts)
    if (!decoded.reason && verificationFile) {
      try {
        const v: unknown = JSON.parse(readFileSync(verificationFile, 'utf8'))
        if (record(v) && v.version === 1 && v.root === root &&
          v.configFingerprint === decoded.state.configFingerprint && v.updatedAt === decoded.state.updatedAt &&
          integer(v.verifiedAt) && v.verifiedAt >= decoded.state.verifiedAt) decoded.state.verifiedAt = v.verifiedAt
      } catch { /* Advisory metadata is disposable; source reconciliation still runs. */ }
    }
    return decoded
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
    return { state: emptyState(root, opts), corrupt: !missing, reason: missing ? '' : 'unreadable or truncated cache' }
  }
}

export function encodeIndex(state: IndexState): string {
  const fileList = Object.keys(state.files)
  const ids = new Map(fileList.map((f, i) => [f, i]))
  const symbols: SymbolRow[] = []
  for (const s of state.symbols) {
    const f = ids.get(s.file)
    if (f !== undefined) symbols.push({ n: s.name, f, l: s.line, k: s.kind, c: s.context })
  }
  const persisted: PersistedIndexState = {
    version: state.version, root: state.root, updatedAt: state.updatedAt, verifiedAt: state.verifiedAt,
    configFingerprint: state.configFingerprint, files: state.files, fileList, symbols,
    imports: state.imports, graph: state.graph,
  }
  return JSON.stringify(persisted)
}
