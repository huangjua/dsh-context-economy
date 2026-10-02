import { open, type FileHandle } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'

export interface SliceRequest {
  startBytes?: number
  lengthBytes?: number
  find?: string
  findFrom?: number
  contextBefore?: number
  mode?: 'window' | 'tail'
  re?: boolean
  /** Per-search byte budget, default 64 MiB literal / 16 MiB regex; hard cap 64 MiB. */
  searchMaxBytes?: number
  /** Overall worker lifetime, including startup and reading; default 1000 ms, cap 10000 ms. */
  searchBudgetMs?: number
}

export interface SliceResult {
  path: string
  /** Exact UTF-8 byte range [byteOffset, nextByteOffset). */
  byteOffset: number
  lengthBytes: number
  totalBytes: number
  snippet: string
  nextByteOffset: number
  hitByteOffset?: number
  tailOffset?: number
  /** True when another content page exists. */
  mayTruncate: boolean
  rangeAdjusted: boolean
  requestedStartBytes: number
  requestedLengthBytes: number
  searchStatus: 'not_requested' | 'matched' | 'not_found' | 'byte_budget' | 'time_budget'
  /** True only when a no-match search has covered all remaining bytes. */
  searchComplete: boolean
  scannedBytes: number
  /** Regex anchors/lookaround see exactly this bounded substring, including its endpoints. */
  searchScope: 'none' | 'remaining_file' | 'bounded_regex_window'
  searchByteStart?: number
  searchByteEnd?: number
  /** Safe literal-search continuation. Absent for incomplete arbitrary regex searches. */
  nextFindFrom?: number
  searchDiagnostic?: string
}

const CHUNK = 64 * 1024
const MAX_WINDOW = 16 * 1024 * 1024
const MAX_SEARCH = 64 * 1024 * 1024
export const sliceDiagnostics = { activeWorkers: 0, startedWorkers: 0, terminatedWorkers: 0 }

function integer(value: number | undefined, fallback: number, name: string, minimum: number, maximum: number): number {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new Error(`slice_invalid_${name}: expected integer ${minimum}..${maximum}`)
  return n
}

// A single self-contained worker per search. Literal KMP retains only the pattern and
// its byte-position ring; regex receives one bounded continuous window, so matches
// can cross any 64 KiB read boundary within that window. No guessed regex overlap.
const SEARCH_WORKER = String.raw`
const { workerData: d, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const CHUNK = 65536;
const fold = (s) => Array.from(s, c => c.toLowerCase()).join('');
let fd;
try {
  fd = fs.openSync(d.path, 'r');
  const total = fs.fstatSync(fd).size;
  let from = Math.min(d.from, total);
  if (from < total) {
    const head = Buffer.alloc(4);
    const n = fs.readSync(fd, head, 0, Math.min(4, total - from), from);
    let skip = 0;
    while (skip < n && (head[skip] & 0xc0) === 0x80) skip++;
    from += skip;
  }
  let pos = from;
  const end = Math.min(total, from + d.maxBytes);
  if (d.regex) {
    const chunks = [];
    while (pos < end) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, end - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      chunks.push(buf.subarray(0, n)); pos += n;
      parentPort.postMessage({ progress: true, scannedBytes: pos - from, byteStart: from, byteEnd: pos });
    }
    let bytes = Buffer.concat(chunks);
    // Do not turn a partial final UTF-8 sequence into a replacement character.
    if (pos < total && bytes.length) {
      let lead = bytes.length - 1;
      while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
      if (lead >= 0) {
        const b = bytes[lead];
        const width = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
        if (lead + width > bytes.length) bytes = bytes.subarray(0, lead);
      }
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    parentPort.postMessage({ progress: true, scannedBytes: pos - from, byteStart: from, byteEnd: from + bytes.length });
    const match = new RegExp(d.pattern, d.flags || 'i').exec(text);
    const hit = match ? from + Buffer.byteLength(text.slice(0, match.index), 'utf8') : undefined;
    parentPort.postMessage({ result: true, hit, scannedBytes: pos - from, byteStart: from, byteEnd: from + bytes.length,
      status: hit !== undefined ? 'matched' : pos >= total ? 'not_found' : 'byte_budget',
      complete: hit === undefined && pos >= total });
  } else {
    const needle = fold(d.pattern);
    const failure = new Uint32Array(needle.length);
    for (let i = 1, j = 0; i < needle.length; i++) {
      while (j && needle[i] !== needle[j]) j = failure[j - 1];
      if (needle[i] === needle[j]) j++;
      failure[i] = j;
    }
    const offsets = new Float64Array(needle.length);
    let matched = 0, units = 0, carry = Buffer.alloc(0), processed = from, hit;
    let safeNext = from;
    search: while (pos < end) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, end - pos));
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (!n) break;
      pos += n;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const base = processed;
      let safe = buf.length;
      if (pos < total && safe) {
        let lead = safe - 1;
        while (lead >= 0 && (buf[lead] & 0xc0) === 0x80) lead--;
        if (lead >= 0) {
          const b = buf[lead];
          const width = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
          if (lead + width > safe) safe = lead;
        }
      }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, safe));
      let byte = base;
      for (const cp of text) {
        const folded = cp.toLowerCase();
        for (let i = 0; i < folded.length; i++) {
          const c = folded[i];
          offsets[units % needle.length] = byte;
          units++;
          while (matched && c !== needle[matched]) matched = failure[matched - 1];
          if (c === needle[matched]) matched++;
          if (matched === needle.length) {
            hit = offsets[(units - needle.length) % needle.length];
            break search;
          }
        }
        byte += Buffer.byteLength(cp, 'utf8');
      }
      processed = base + safe;
      carry = buf.subarray(safe);
      safeNext = matched ? offsets[(units - matched) % needle.length] : processed;
      parentPort.postMessage({ progress: true, scannedBytes: pos - from, nextFindFrom: safeNext, byteStart: from, byteEnd: processed });
    }
    const status = hit !== undefined ? 'matched' : pos >= total ? 'not_found' : 'byte_budget';
    parentPort.postMessage({ result: true, hit, scannedBytes: pos - from, status, byteStart: from, byteEnd: pos,
      complete: hit === undefined && pos >= total,
      nextFindFrom: status === 'byte_budget' && safeNext > from ? safeNext : undefined });
  }
} catch (e) { parentPort.postMessage({ error: e.message }); }
finally { if (fd !== undefined) fs.closeSync(fd); }
`

interface SearchResult {
  hit?: number
  scannedBytes: number
  status: SliceResult['searchStatus']
  complete: boolean
  nextFindFrom?: number
  byteStart?: number
  byteEnd?: number
}

async function search(path: string, request: SliceRequest, signal?: AbortSignal): Promise<SearchResult> {
  const from = integer(request.findFrom, 0, 'findFrom', 0, Number.MAX_SAFE_INTEGER)
  const maxBytes = integer(request.searchMaxBytes, request.re ? MAX_WINDOW : MAX_SEARCH, 'searchMaxBytes', 1, MAX_SEARCH)
  const budgetMs = integer(request.searchBudgetMs, 1000, 'searchBudgetMs', 1, 10000)
  if (request.find!.length > (request.re ? 256 : CHUNK)) throw new Error(request.re ? 'slice_find_regex_too_long' : 'slice_find_literal_too_long')
  if (request.re) new RegExp(request.find!, 'i') // Compile only; execution stays inside the worker.
  signal?.throwIfAborted()
  const started = performance.now()
  const worker = new Worker(SEARCH_WORKER, { execArgv: [], eval: true, workerData: {
    path, from, maxBytes, pattern: request.find, regex: request.re === true,
  } })
  sliceDiagnostics.startedWorkers++
  sliceDiagnostics.activeWorkers++
  let progress: SearchResult = { status: 'time_budget', complete: false, scannedBytes: 0, byteStart: from, byteEnd: from }
  try {
    return await new Promise<SearchResult>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        worker.off('message', message)
        worker.off('error', failed)
        worker.off('exit', exited)
        signal?.removeEventListener('abort', aborted)
      }
      const finish = (value?: SearchResult, error?: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        if (error !== undefined) reject(error)
        else resolve(value!)
      }
      const message = (m: { progress?: boolean; result?: boolean; error?: string } & SearchResult) => {
        if (m.error) finish(undefined, new Error(m.error))
        else if (m.result) finish(m)
        else if (m.progress) progress = { ...progress, scannedBytes: m.scannedBytes, byteStart: m.byteStart, byteEnd: m.byteEnd,
          nextFindFrom: m.nextFindFrom !== undefined && m.nextFindFrom > from ? m.nextFindFrom : undefined }
      }
      const failed = (e: Error) => finish(undefined, e)
      const exited = (code: number) => finish(undefined, new Error(`slice_search_worker_exit:${code}`))
      const aborted = () => finish(undefined, signal?.reason ?? new Error('slice_aborted'))
      const timer = setTimeout(() => finish(progress), Math.max(1, budgetMs - (performance.now() - started)))
      worker.on('message', message)
      worker.on('error', failed)
      worker.on('exit', exited)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  } finally {
    await worker.terminate()
    sliceDiagnostics.activeWorkers--
    sliceDiagnostics.terminatedWorkers++
  }
}

async function boundaryForward(fd: FileHandle, position: number, total: number): Promise<number> {
  if (position >= total) return total
  const buf = Buffer.alloc(4)
  const { bytesRead } = await fd.read(buf, 0, Math.min(4, total - position), position)
  let skip = 0
  while (skip < bytesRead && (buf[skip] & 0xc0) === 0x80) skip++
  return Math.min(total, position + skip)
}

/** Async UTF-8 windows with exact half-open byte ranges and bounded worker search. */
export async function sliceRead(absPath: string, request: SliceRequest, signal?: AbortSignal): Promise<SliceResult> {
  const length = integer(request.lengthBytes, 4096, 'lengthBytes', 1, MAX_WINDOW)
  const start = integer(request.startBytes, 0, 'startBytes', 0, Number.MAX_SAFE_INTEGER)
  const before = integer(request.contextBefore, 256, 'contextBefore', 0, MAX_WINDOW)
  if (request.mode !== undefined && request.mode !== 'window' && request.mode !== 'tail') throw new Error('slice_invalid_mode')
  signal?.throwIfAborted()
  const fd = await open(absPath, 'r')
  try {
    const total = (await fd.stat()).size
    let offset = Math.min(start, total)
    let found: SearchResult = { status: 'not_requested', complete: false, scannedBytes: 0 }
    if (request.mode === 'tail') offset = Math.max(0, total - length)
    else if (request.find) {
      found = await search(absPath, request, signal)
      offset = found.hit === undefined ? Math.min(request.findFrom ?? 0, total) : Math.max(0, found.hit - before)
    }
    signal?.throwIfAborted()
    const requestedOffset = offset
    offset = await boundaryForward(fd, offset, total)
    const end = await boundaryForward(fd, Math.min(total, offset + length), total)
    const bytes = Buffer.alloc(end - offset)
    let n = 0
    while (n < bytes.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await fd.read(bytes, n, Math.min(CHUNK, bytes.length - n), offset + n)
      if (!bytesRead) break
      n += bytesRead
    }
    signal?.throwIfAborted()
    let snippet: string
    try { snippet = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, n)) }
    catch { throw new Error('slice_invalid_utf8: requested byte range is not valid UTF-8') }
    const result: SliceResult = {
      path: absPath, byteOffset: offset, lengthBytes: n, totalBytes: total,
      snippet, nextByteOffset: offset + n, mayTruncate: offset + n < total,
      rangeAdjusted: offset !== requestedOffset || n > length,
      requestedStartBytes: requestedOffset, requestedLengthBytes: length,
      searchStatus: found.status, searchComplete: found.complete, scannedBytes: found.scannedBytes,
      searchScope: found.status === 'not_requested' ? 'none' : request.re ? 'bounded_regex_window' : 'remaining_file',
    }
    if (found.hit !== undefined) result.hitByteOffset = found.hit
    if (found.nextFindFrom !== undefined) result.nextFindFrom = found.nextFindFrom
    if (found.byteStart !== undefined) result.searchByteStart = found.byteStart
    if (found.byteEnd !== undefined) result.searchByteEnd = found.byteEnd
    if (request.mode === 'tail') result.tailOffset = offset
    if (found.status === 'byte_budget' || found.status === 'time_budget') {
      result.searchDiagnostic = request.re
        ? 'Search incomplete: arbitrary regex uses one continuous bounded window. Increase searchMaxBytes/searchBudgetMs and retry the same findFrom; no safe skip offset exists for matches spanning that window.'
        : found.nextFindFrom !== undefined
          ? 'Search incomplete: resume with nextFindFrom and the same find parameters.'
          : 'Search incomplete before a safe continuation boundary: increase searchMaxBytes/searchBudgetMs and retry the same findFrom.'
    } else if (found.status === 'not_found') result.searchDiagnostic = 'No match in the complete remaining file.'
    if (result.searchScope === 'bounded_regex_window') {
      const scope = `Regex scope is the UTF-8 substring [${result.searchByteStart}, ${result.searchByteEnd}); anchors and lookaround see these window boundaries.`
      result.searchDiagnostic = result.searchDiagnostic ? `${scope} ${result.searchDiagnostic}` : scope
    }
    return result
  } finally { await fd.close() }
}

/** Backwards-compatible protected regex helper; always awaits worker shutdown. */
export async function regexFirstMatch(text: string, re: RegExp, budgetMs = 250, signal?: AbortSignal): Promise<number | null> {
  integer(budgetMs, 250, 'searchBudgetMs', 1, 10000)
  signal?.throwIfAborted()
  const worker = new Worker(String.raw`
    const { workerData: d, parentPort } = require('node:worker_threads');
    try { const m = new RegExp(d.source, d.flags).exec(d.text); parentPort.postMessage(m ? m.index : null); }
    catch (e) { throw e; }
  `, { execArgv: [], eval: true, workerData: { text, source: re.source, flags: re.flags } })
  sliceDiagnostics.startedWorkers++; sliceDiagnostics.activeWorkers++
  try {
    return await new Promise<number | null>((resolve, reject) => {
      let settled = false
      const finish = (value: number | null, e?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        if (e !== undefined) reject(e); else resolve(value)
      }
      const aborted = () => finish(null, signal?.reason ?? new Error('slice_aborted'))
      const timer = setTimeout(() => finish(null, new Error('slice_find_regex_timeout')), budgetMs)
      worker.once('message', (n) => finish(typeof n === 'number' ? n : null))
      worker.once('error', (e) => finish(null, e))
      worker.once('exit', () => finish(null, new Error('slice_find_regex_timeout')))
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  } finally {
    await worker.terminate()
    sliceDiagnostics.activeWorkers--; sliceDiagnostics.terminatedWorkers++
  }
}
