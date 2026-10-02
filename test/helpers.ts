import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, type Config } from '../src/index.js'
import type { IndexOptions } from '../src/core.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const options: IndexOptions = { includeExts: ['.ts', '.js', '.json'], skipDirs: ['node_modules', '.git'],
  maxScanBytes: 512 * 1024, maxContextLen: 240, historyMaxRows: 20 }
export function area() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-abc-'))
  const root = join(base, 'project'), cache = join(base, 'cache')
  mkdirSync(root); mkdirSync(cache)
  return { base, root, cache, put(file: string, content: string) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content)
    return path
  }, cleanup() { rmSync(base, { recursive: true, force: true }) } }
}
export function plugin(root: string, cache: string, overrides: Partial<Config> = {}) {
  const tools: Record<string, ToolDefinition> = {}
  const cleanups: Array<() => void | Promise<void>> = []
  apply({ tools: { register(t: ToolDefinition) { tools[t.name] = t; return () => { delete tools[t.name] } } },
    effect(fn: () => unknown) { const c = fn(); if (typeof c === 'function') cleanups.push(c as () => void | Promise<void>) },
  } as never, { rootDir: root, cacheDir: cache, skipDirs: '.git,node_modules', includeExts: '.ts,.js,.json',
    maxScanBytes: 512 * 1024, maxContextLen: 240, maxHits: 120, sliceBytes: 4096,
    intervalMs: 300000, logFile: '', lowerNameOnly: true, savingsEnabled: false,
    savingsMaxRows: 500, historyMaxRows: 20, ...overrides })
  return { tools, async dispose() { for (const c of cleanups) await c() } }
}

export async function call(tool: ToolDefinition, args: Record<string, unknown>, signal = new AbortController().signal): Promise<any> {
  return tool.execute(args, { signal } as never)
}
