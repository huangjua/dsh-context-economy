#!/usr/bin/env node
/**
 * Verify that this plugin stays installable and loadable against the current
 * DSH desktop runtime (0.2.0-rc.2):
 *  - peerDependencies use forward-compatible ranges (`>=0.1.7-rc.1 <0.3.0`)
 *    so the client's pre-install compatibility gate accepts the plugin;
 *  - devDependencies pin the 0.1.7-rc.1 development corpus;
 *  - pnpm-lock importers match the manifest;
 *  - no npm lockfile coexists with pnpm-lock.yaml.
 * History: originally pinned to exactly 0.1.5-rc.1 (single-version contract);
 * widened on 2026-10-01 when the desktop runtime moved to 0.2.0-rc.2.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const DEV_TARGET = '0.1.7-rc.1'
const PEER_RANGE = '>=0.1.7-rc.1 <0.3.0'
const expected = {
  '@deepseek-ai/dsh-llm': DEV_TARGET,
  '@deepseek-ai/dsh-tools': DEV_TARGET,
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/schemastery': '3.18.2',
}
const errors = []
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lockText = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')

function fail(message) { errors.push(message) }
function check(section, name, expectedValue) {
  if (packageJson[section]?.[name] !== expectedValue) {
    fail(`package.json ${section}.${name} is ${String(packageJson[section]?.[name])}, expected ${expectedValue}`)
  }
}

if (packageJson.peerDependencies?.['@deepseek-ai/dsh-llm'] !== PEER_RANGE) fail(`dsh-llm peer range must be ${PEER_RANGE}`)
if (packageJson.peerDependencies?.['@deepseek-ai/dsh-tools'] !== PEER_RANGE) fail(`dsh-tools peer range must be ${PEER_RANGE}`)
for (const [name, version] of Object.entries(expected)) check('devDependencies', name, version)
if (existsSync(join(root, 'package-lock.json'))) fail('package-lock.json must not coexist with pnpm-lock.yaml')

function lockImporter(name) {
  const lines = lockText.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `      '${name}':`)
  if (start < 0) return undefined
  const fields = {}
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.startsWith('        ')) break
    const match = /^        (specifier|version): (.+)$/.exec(line)
    if (match) fields[match[1]] = match[2]
  }
  return fields
}
for (const [name, version] of Object.entries(expected)) {
  const entry = lockImporter(name)
  if (!entry) {
    fail(`pnpm-lock.yaml importer is missing ${name}`)
    continue
  }
  const expectedSpecifier = name.startsWith('@deepseek-ai/dsh-') ? DEV_TARGET : version
  if (entry.specifier !== expectedSpecifier) fail(`pnpm-lock.yaml importer ${name} specifier is ${String(entry.specifier)}, expected ${expectedSpecifier}`)
  if (!entry.version?.startsWith(version)) fail(`pnpm-lock.yaml importer ${name} resolves ${String(entry.version)}, expected ${version}`)
}

if (errors.length) {
  console.error('INCOMPATIBLE')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`COMPATIBLE: peers ${PEER_RANGE} (desktop runtime 0.2.0-rc.2 compatible); dev corpus ${DEV_TARGET}; Cordis ${expected['@deepseek-ai/cordis']}; Schemastery ${expected['@deepseek-ai/schemastery']}`)
}
