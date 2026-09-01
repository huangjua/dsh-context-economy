#!/usr/bin/env node
/**
 * Compile tests into a disposable node_modules cache directory so npm test
 * never leaves .test-build in the package root and imports resolve against
 * this plugin's own dependency tree.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(project, 'node_modules', '.cache', 'test-build')
const tsc = join(project, 'node_modules', 'typescript', 'bin', 'tsc')
rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
mkdirSync(outDir, { recursive: true })

let exitCode = 0
try {
  if (!existsSync(tsc)) throw new Error(`typescript compiler not found: ${tsc}; run pnpm install first`)
  const compile = spawnSync(process.execPath, [tsc, '-p', join(project, 'tsconfig.test.json'), '--outDir', outDir], {
    cwd: project,
    stdio: 'inherit',
    shell: false,
  })
  if (compile.status !== 0) {
    exitCode = compile.status ?? 1
  } else {
    const testDir = join(outDir, 'test')
    const testFiles = readdirSync(testDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
      .map((entry) => join(testDir, entry.name))
      .sort()
    if (testFiles.length === 0) {
      console.error(`test: compiled no test files in ${testDir}`)
      exitCode = 1
    } else {
      const run = spawnSync(process.execPath, ['--test', ...testFiles], {
        cwd: project,
        stdio: 'inherit',
        shell: false,
      })
      exitCode = run.status ?? 1
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  exitCode = 1
} finally {
  try { rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) } catch { /* cleanup is best effort */ }
}
process.exit(exitCode)
