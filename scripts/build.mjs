#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const project = dirname(root)
const tsc = join(project, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  throw new Error(`typescript compiler not found: ${tsc}; run pnpm install first`)
}

// lib is generated state. Clean it so stale nested/removed entries cannot ship.
rmSync(join(project, 'lib'), { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', join(project, 'tsconfig.json')], {
  cwd: project,
  stdio: 'inherit',
})
