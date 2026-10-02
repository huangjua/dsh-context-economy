import { open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import type { Stats } from 'node:fs'

/** This version also identifies the lexical grammar and cursor boundary contract. */
export const JSON_SCANNER_VERSION = 1
export const JSON_LIMITS = Object.freeze({ limit: 40, maxLimit: 1000, maxPreview: 240,
  maxKeyBytes: 4096, maxDepth: 128, maxScanBytes: 16 * 1024 * 1024,
  maxTimeMs: 2000, maxOutputBytes: 64 * 1024 })

export interface JsonEntry { key: string; byteStart: number; byteEnd: number; preview: string }
export interface JsonScanOptions {
  limit?: number; cursor?: string; maxPreview?: number; maxKeyBytes?: number
  maxDepth?: number; maxScanBytes?: number; maxTimeMs?: number; maxOutputBytes?: number
  signal?: AbortSignal
  /** Internal worker transport only. Reuse a random secret for the plugin lifetime, never expose it as a tool argument. */
  cursorSecret?: string
}
export interface JsonScanResult {
  topLevel: 'object' | 'array' | 'primitive' | 'error'
  error?: string; diagnosticCode?: string
  /** Absent until the closing root and the entire trailing region have been checked. */
  totalKeys?: number; totalKeysKnown: boolean
  entries: JsonEntry[]; topPreview: string
  hasMore: boolean; nextCursor?: string
  validation: 'complete' | 'incomplete' | 'invalid' | 'budget_exhausted' | 'cancelled'
  scannedBytes: number; readBytes: number; scanStartByte: number; scanEndByte: number; elapsedMs: number
  /** On a budget failure, use these byte locations with project_slice_read. No retry cursor is issued. */
  resumeByteOffset?: number; valueByteStart?: number
}

type Frame = { kind: 'object'; state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd' }
  | { kind: 'array'; state: 'valueOrEnd' | 'value' | 'commaOrEnd' }
type Cursor = { v: number; path: string; fingerprint: string; offset: number; count: number }
const digest = (text: string) => createHash('sha256').update('dsh-json-cursor-v1\0' + text).digest('hex')
const processCursorSecret = randomBytes(32).toString('hex')
const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('hex')
const fingerprint = (s: Stats) => digest(JSON.stringify([s.size, s.mtimeMs, s.ctimeMs, s.ino, s.dev]))
const whitespace = (b: number) => b === 32 || b === 9 || b === 10 || b === 13
const delimiter = (b: number) => whitespace(b) || b === 44 || b === 93 || b === 125
const digit = (b: number) => b >= 48 && b <= 57
const hex = (b: number) => digit(b) || b >= 65 && b <= 70 || b >= 97 && b <= 102
function integer(value: number | undefined, fallback: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`invalid_${name}: expected integer in 1..${max}`)
  return n
}
function encodeCursor(cursor: Cursor, secret: string): string {
  const payload = JSON.stringify(cursor)
  return Buffer.from(JSON.stringify({ payload, checksum: sign(payload, secret) })).toString('base64url')
}
function decodeCursor(text: string, path: string, fp: string, size: number, secret: string): Cursor {
  try {
    if (text.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('shape')
    const envelope = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
    if (typeof envelope.payload !== 'string' || typeof envelope.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.checksum) ||
      !timingSafeEqual(Buffer.from(envelope.checksum), Buffer.from(sign(envelope.payload, secret)))) throw new Error('checksum')
    const c = JSON.parse(envelope.payload) as Cursor
    if (c.v !== JSON_SCANNER_VERSION || c.path !== path || c.fingerprint !== fp) throw new Error('changed')
    if (!Number.isSafeInteger(c.offset) || c.offset < 1 || c.offset >= size ||
      !Number.isSafeInteger(c.count) || c.count < 1 || c.count > c.offset / 4) throw new Error('offset')
    return c
  } catch { throw new Error('invalid_cursor: file/path/scanner/plugin lifetime changed or cursor is malformed; restart without cursor') }
}

/**
 * A deterministic JSON pushdown parser, processing bounded asynchronous byte chunks.
 * A continuation stores ONLY the boundary following a completed root member's comma.
 * It carries no nested stack or partial value, and never requests a scan of prior pages.
 * Continuations are authenticated with a secret shared only within the plugin lifetime.
 */
export async function scanJsonKeys(absPath: string, opts: JsonScanOptions = {}): Promise<JsonScanResult> {
  const began = performance.now()
  const cursorSecret = opts.cursorSecret ?? processCursorSecret
  const limit = integer(opts.limit, JSON_LIMITS.limit, 'limit', JSON_LIMITS.maxLimit)
  const maxPreview = integer(opts.maxPreview, JSON_LIMITS.maxPreview, 'maxPreview', 4096)
  const maxKeyBytes = integer(opts.maxKeyBytes, JSON_LIMITS.maxKeyBytes, 'maxKeyBytes', 65536)
  const maxDepth = integer(opts.maxDepth, JSON_LIMITS.maxDepth, 'maxDepth', 512)
  const maxScanBytes = integer(opts.maxScanBytes, JSON_LIMITS.maxScanBytes, 'maxScanBytes')
  const maxTimeMs = integer(opts.maxTimeMs, JSON_LIMITS.maxTimeMs, 'maxTimeMs', 60000)
  const maxOutputBytes = integer(opts.maxOutputBytes, JSON_LIMITS.maxOutputBytes, 'maxOutputBytes', 1024 * 1024)
  // The reserved envelope keeps full entry serialization within the declared output budget.
  // Includes the worst authenticated cursor plus tool root/path fields (each capped at 1024 UTF-8 bytes).
  const envelopeBytes = 8192
  const entriesBudget = maxOutputBytes - envelopeBytes
  const entries: JsonEntry[] = []
  let path = resolve(absPath), fp = '', start = 0, pos = 0, count = 0, pageBoundary = 0, readBytes = 0
  let topLevel: JsonScanResult['topLevel'] = 'error', diagnosticCode: string | undefined
  const topHead: number[] = []
  let error: string | undefined, validation: JsonScanResult['validation'] = 'incomplete', hasMore = false
  let resumeByteOffset: number | undefined, valueByteStart: number | undefined, outputBytes = 0
  const result = (): JsonScanResult => ({ topLevel, entries,
    topPreview: topLevel === 'object' ? '' : new TextDecoder('utf-8').decode(Buffer.from(topHead), { stream: true }).slice(0, maxPreview),
    hasMore, validation,
    totalKeysKnown: validation === 'complete' && topLevel === 'object',
    ...(validation === 'complete' && topLevel === 'object' ? { totalKeys: count } : {}),
    ...(hasMore ? { nextCursor: encodeCursor({ v: JSON_SCANNER_VERSION, path, fingerprint: fp, offset: pageBoundary, count }, cursorSecret) } : {}),
    ...(error ? { error } : {}), ...(diagnosticCode ? { diagnosticCode } : {}),
    ...(resumeByteOffset !== undefined ? { resumeByteOffset } : {}),
    ...(valueByteStart !== undefined ? { valueByteStart } : {}),
    scannedBytes: pos - start, readBytes, scanStartByte: start, scanEndByte: pos, elapsedMs: performance.now() - began })
  const fail = (code: string, reason: string, status: JsonScanResult['validation'] = 'invalid') => {
    diagnosticCode = code; error = `${reason} @byte ${pos}`; validation = status; hasMore = false
    if (status === 'budget_exhausted') { resumeByteOffset = pos; valueByteStart = current?.byteStart }
  }
  let current: JsonEntry | undefined, pending: JsonEntry | undefined, valueActive = false
  let preview: number[] = [], previewBudget = maxPreview * 4 + 4, keyBoundary = 0
  const stack: Frame[] = []
  let rootStarted = false, rootDone = false, stopped = false
  let token: 'string' | 'number' | 'literal' | undefined
  let stringKey = false, rootKey = false, keyRaw: number[] = [], keyBytes = 0
  let escape = 0, unicode = 0, utfRemaining = 0, utfMin = 128, utfMax = 191
  let numberState: 'minus' | 'zero' | 'int' | 'dot' | 'frac' | 'exp' | 'expSign' | 'expDigits' = 'int'
  let literal = '', literalIndex = 0
  const parent = () => stack[stack.length - 1]
  const finishValue = (end: number) => {
    token = undefined
    const frame = parent()
    if (!frame) { rootDone = true; return }
    frame.state = 'commaOrEnd'
    if (stack.length === 1 && frame.kind === 'object' && current) {
      current.byteEnd = end
      let text = new TextDecoder('utf-8').decode(Buffer.from(preview), { stream: true })
      if (text.length > maxPreview) {
        text = text.slice(0, maxPreview)
        if (text.charCodeAt(text.length - 1) >= 0xd800 && text.charCodeAt(text.length - 1) <= 0xdbff) text = text.slice(0, -1)
      }
      if (end - current.byteStart > Buffer.byteLength(text)) text += '…'
      // Key and pointer remain visible even when the preview must shrink to meet the page budget.
      current.preview = text
      const available = entriesBudget - outputBytes - 1
      if (Buffer.byteLength(JSON.stringify(current)) > available) {
        const safePrefix = (length: number) => {
          const last = text.charCodeAt(length - 1)
          return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length)
        }
        // JSON-escaped UTF-8 bytes grow monotonically at complete code point boundaries.
        let low = 0, high = text.length
        while (low < high) {
          const middle = Math.ceil((low + high) / 2)
          current.preview = safePrefix(middle)
          if (Buffer.byteLength(JSON.stringify(current)) <= available) low = middle
          else high = middle - 1
        }
        current.preview = safePrefix(low)
      }
      pending = current; current = undefined; valueActive = false; preview = []
    }
  }
  const keepPending = () => {
    if (pending) { entries.push(pending); outputBytes += Buffer.byteLength(JSON.stringify(pending)) + 1; count++; pending = undefined }
  }
  const beginValue = (b: number) => {
    if (!rootStarted) {
      rootStarted = true
      topLevel = b === 123 ? 'object' : b === 91 ? 'array' : 'primitive'
    }
    const frame = parent()
    if (stack.length === 1 && frame.kind === 'object' && current) {
      current.byteStart = pos; valueActive = true; preview = []
    }
    if (b === 123 || b === 91) {
      if (stack.length >= maxDepth) { fail('depth_budget_exhausted', `JSON nesting exceeds ${maxDepth}`, 'budget_exhausted'); return }
      stack.push(b === 123 ? { kind: 'object', state: 'keyOrEnd' } : { kind: 'array', state: 'valueOrEnd' })
    } else if (b === 34) {
      token = 'string'; stringKey = false; rootKey = false; escape = unicode = utfRemaining = 0
    } else if (b === 45 || digit(b)) {
      token = 'number'; numberState = b === 45 ? 'minus' : b === 48 ? 'zero' : 'int'
    } else if (b === 116 || b === 102 || b === 110) {
      token = 'literal'; literal = b === 116 ? 'true' : b === 102 ? 'false' : 'null'; literalIndex = 1
    } else fail('invalid_value', 'Expected a JSON value')
  }
  // Returns false when a completed scalar has left its delimiter for the structural parser.
  const step = (b: number): boolean => {
    if (token === 'string') {
      if (stringKey) {
        if (b !== 34 || escape || unicode || utfRemaining) keyBytes++
        if (keyBytes > maxKeyBytes) { fail('key_budget_exhausted', `JSON key exceeds ${maxKeyBytes} encoded bytes`, 'budget_exhausted'); return true }
        if (rootKey) keyRaw.push(b)
      }
      if (utfRemaining) {
        if (b < utfMin || b > utfMax) fail('invalid_utf8', 'Invalid UTF-8 inside JSON string')
        utfRemaining--; utfMin = 128; utfMax = 191; return true
      }
      if (unicode) { if (!hex(b)) fail('invalid_escape', 'Invalid hexadecimal Unicode escape'); unicode--; return true }
      if (escape) {
        escape = 0
        if (b === 117) unicode = 4
        else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(b)) fail('invalid_escape', 'Invalid JSON string escape')
        return true
      }
      if (b === 92) { escape = 1; return true }
      if (b === 34) {
        token = undefined
        if (stringKey) {
          const frame = parent(); frame.state = 'colon'
          if (rootKey) {
            const key = JSON.parse(Buffer.from(keyRaw).toString('utf8')) as string
            const skeleton = { key, byteStart: Number.MAX_SAFE_INTEGER, byteEnd: Number.MAX_SAFE_INTEGER, preview: '' }
            if (Buffer.byteLength(JSON.stringify(skeleton)) + 1 > entriesBudget - outputBytes) {
              if (entries.length) { hasMore = true; pageBoundary = keyBoundary; stopped = true }
              else fail('output_budget_exhausted', `Key and byte pointers exceed ${maxOutputBytes} output bytes`, 'budget_exhausted')
            } else current = { key, byteStart: pos, byteEnd: pos, preview: '' }
          }
        } else finishValue(pos + 1)
      } else if (b < 32) fail('invalid_string', 'Unescaped control byte in JSON string')
      else if (b >= 128) {
        if (b >= 194 && b <= 223) utfRemaining = 1
        else if (b >= 224 && b <= 239) { utfRemaining = 2; utfMin = b === 224 ? 160 : 128; utfMax = b === 237 ? 159 : 191 }
        else if (b >= 240 && b <= 244) { utfRemaining = 3; utfMin = b === 240 ? 144 : 128; utfMax = b === 244 ? 143 : 191 }
        else fail('invalid_utf8', 'Invalid UTF-8 inside JSON string')
      }
      return true
    }
    if (token === 'literal') {
      if (literalIndex < literal.length) {
        if (b !== literal.charCodeAt(literalIndex++)) fail('invalid_literal', 'Invalid JSON literal')
        return true
      }
      if (!delimiter(b)) { fail('invalid_literal', 'Unexpected suffix after JSON literal'); return true }
      finishValue(pos); return false
    }
    if (token === 'number') {
      if (digit(b)) {
        if (numberState === 'zero') fail('invalid_number', 'JSON number has a leading zero')
        else if (numberState === 'minus') numberState = b === 48 ? 'zero' : 'int'
        else if (numberState === 'dot') numberState = 'frac'
        else if (numberState === 'exp' || numberState === 'expSign') numberState = 'expDigits'
        return true
      }
      if (b === 46 && (numberState === 'int' || numberState === 'zero')) { numberState = 'dot'; return true }
      if ((b === 69 || b === 101) && ['zero', 'int', 'frac'].includes(numberState)) { numberState = 'exp'; return true }
      if ((b === 43 || b === 45) && numberState === 'exp') { numberState = 'expSign'; return true }
      if (!delimiter(b) || !['zero', 'int', 'frac', 'expDigits'].includes(numberState)) { fail('invalid_number', 'Malformed JSON number'); return true }
      finishValue(pos); return false
    }
    if (whitespace(b)) return true
    if (rootDone) { fail('trailing_content', 'Unexpected content after JSON root'); return true }
    const frame = parent()
    if (!frame) { beginValue(b); return true }
    if (frame.kind === 'object') {
      if (frame.state === 'keyOrEnd' || frame.state === 'key') {
        if (b === 125 && frame.state === 'keyOrEnd') { stack.pop(); finishValue(pos + 1); return true }
        if (b !== 34) { fail('invalid_object_key', 'Expected quoted object key (trailing commas are invalid)'); return true }
        token = 'string'; stringKey = true; rootKey = stack.length === 1
        escape = unicode = utfRemaining = keyBytes = 0; keyRaw = rootKey ? [34] : []
        if (rootKey) keyBoundary = pageBoundary
      } else if (frame.state === 'colon') {
        if (b !== 58) fail('missing_colon', 'Expected colon after object key')
        else frame.state = 'value'
      } else if (frame.state === 'value') beginValue(b)
      else if (b === 44 || b === 125) {
        if (stack.length === 1) keepPending()
        if (b === 125) { stack.pop(); finishValue(pos + 1) }
        else {
          frame.state = 'key'
          if (stack.length === 1) {
            pageBoundary = pos + 1
            if (entries.length >= limit) { hasMore = true; stopped = true }
          }
        }
      } else fail('missing_separator', 'Expected comma or object closing brace')
    } else {
      if (frame.state === 'valueOrEnd' && b === 93) { stack.pop(); finishValue(pos + 1) }
      else if (frame.state === 'valueOrEnd' || frame.state === 'value') beginValue(b)
      else if (b === 44) frame.state = 'value'
      else if (b === 93) { stack.pop(); finishValue(pos + 1) }
      else fail('missing_separator', 'Expected comma or array closing bracket')
    }
    return true
  }
  if (opts.signal?.aborted) { fail('cancelled', 'JSON scan cancelled', 'cancelled'); return result() }
  const handle = await open(path, 'r')
  try {
    path = await realpath(path)
    if (Buffer.byteLength(path) > 1024) { fail('path_budget_exhausted', 'Normalized path exceeds cursor budget', 'budget_exhausted'); return result() }
    const stat = await handle.stat(); fp = fingerprint(stat)
    if (!stat.isFile()) { fail('invalid_file', 'JSON input must be a regular file'); return result() }
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor, path, fp, stat.size, cursorSecret)
      start = pos = pageBoundary = c.offset; count = c.count; rootStarted = true; topLevel = 'object'
      const prior = Buffer.alloc(1); readBytes += (await handle.read(prior, 0, 1, start - 1)).bytesRead
      if (prior[0] !== 44) throw new Error('invalid_cursor: continuation is not after a member comma; restart without cursor')
      stack.push({ kind: 'object', state: 'key' })
    }
    const chunk = Buffer.allocUnsafe(Math.min(65536, maxScanBytes))
    while (pos < stat.size && !stopped && !diagnosticCode) {
      if (opts.signal?.aborted) { fail('cancelled', 'JSON scan cancelled', 'cancelled'); break }
      if (performance.now() - began >= maxTimeMs) { fail('time_budget_exhausted', `JSON scan exceeds ${maxTimeMs} ms`, 'budget_exhausted'); break }
      const remain = maxScanBytes - (pos - start)
      if (remain <= 0) { fail('scan_budget_exhausted', `JSON page scan exceeds ${maxScanBytes} bytes; use slice at the supplied byte locations`, 'budget_exhausted'); break }
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, remain, stat.size - pos), pos)
      readBytes += bytesRead
      if (!bytesRead) { fail('file_changed', 'File ended before its recorded size'); break }
      let i = 0
      while (i < bytesRead && !stopped && !diagnosticCode) {
        const b = chunk[i]
        const wasActive = valueActive
        const scalarDelimiter = delimiter(b) && (token === 'number' || token === 'literal' && literalIndex === literal.length)
        if (valueActive && !scalarDelimiter && preview.length < previewBudget) preview.push(b)
        const consumed = step(b)
        if (consumed) {
          if (!wasActive && valueActive && preview.length < previewBudget) preview.push(b)
          if (topLevel !== 'object' && topHead.length < maxPreview * 4 + 4) topHead.push(b)
          pos++; i++
        }
        if ((pos - start) % 2048 === 0) {
          if (opts.signal?.aborted) { fail('cancelled', 'JSON scan cancelled', 'cancelled'); break }
          if (performance.now() - began >= maxTimeMs) { fail('time_budget_exhausted', `JSON scan exceeds ${maxTimeMs} ms`, 'budget_exhausted'); break }
        }
      }
      await yieldTurn()
    }
    if (opts.signal?.aborted && !diagnosticCode) fail('cancelled', 'JSON scan cancelled', 'cancelled')
    if (!diagnosticCode && performance.now() - began >= maxTimeMs) fail('time_budget_exhausted', `JSON scan exceeds ${maxTimeMs} ms`, 'budget_exhausted')
    if (hasMore && pageBoundary >= stat.size) fail('unexpected_eof', 'JSON input ends after a member comma')
    if (!stopped && !diagnosticCode && pos === stat.size) {
      if (token === 'number' && ['zero', 'int', 'frac', 'expDigits'].includes(numberState)) finishValue(pos)
      else if (token === 'literal' && literalIndex === literal.length) finishValue(pos)
      if (!rootDone || stack.length || token) fail('unexpected_eof', rootStarted ? 'JSON input is not closed or has an unfinished token' : 'Empty JSON input')
      else {
        validation = 'complete'
        if (topLevel !== 'object') { diagnosticCode = 'unsupported_top_level'; error = `JSON ${topLevel} root is valid; top-level key pagination requires an object` }
      }
    }
    if (fingerprint(await handle.stat()) !== fp) { fail('file_changed', 'File changed during JSON scan; restart without cursor'); entries.length = 0 }
    return result()
  } finally { await handle.close() }
}
