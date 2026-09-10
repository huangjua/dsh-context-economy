#!/usr/bin/env node
/**
 * Verify that this plugin is developed and resolved against one rc.1 DSH
 * runtime. The peer ranges and local build are intentionally pinned to rc.1.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = process.cwd()
const target = '0.1.5-rc.1'
const expected = {
  '@deepseek-ai/dsh-llm': target,
  '@deepseek-ai/dsh-tools': target,
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

if (packageJson.peerDependencies?.['@deepseek-ai/dsh-llm'] !== target) fail(`dsh-llm peer range must target ${target}`)
if (packageJson.peerDependencies?.['@deepseek-ai/dsh-tools'] !== target) fail(`dsh-tools peer range must target ${target}`)
if (packageJson.peerDependencies?.['@deepseek-ai/cordis'] !== '4.0.1 || 4.0.2') fail('cordis peer range must retain 4.0.1 and 4.0.2')
if (packageJson.peerDependencies?.['@deepseek-ai/schemastery'] !== '3.18.1 || 3.18.2') fail('schemastery peer range must retain 3.18.1 and 3.18.2')
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
  const expectedSpecifier = name.startsWith('@deepseek-ai/dsh-') ? target : version
  if (entry.specifier !== expectedSpecifier) fail(`pnpm-lock.yaml importer ${name} specifier is ${String(entry.specifier)}, expected ${expectedSpecifier}`)
  if (!entry.version?.startsWith(version)) fail(`pnpm-lock.yaml importer ${name} resolves ${String(entry.version)}, expected ${version}`)
}

function packagePath(base, name) { return join(base, 'node_modules', ...name.split('/'), 'package.json') }
const visited = new Set()
const versions = new Map()
function visit(name, base) {
  const candidate = packagePath(base, name)
  if (!existsSync(candidate)) return
  const jsonPath = realpathSync(candidate)
  if (visited.has(jsonPath)) return
  visited.add(jsonPath)
  const json = JSON.parse(readFileSync(jsonPath, 'utf8'))
  if (json.name.startsWith('@deepseek-ai/dsh-')) {
    const found = versions.get(json.name) ?? new Set()
    found.add(json.version)
    versions.set(json.name, found)
  }
  const dependencies = { ...json.dependencies, ...json.optionalDependencies, ...json.peerDependencies }
  const packageRoot = dirname(jsonPath)
  for (const dependency of Object.keys(dependencies)) {
    if (dependency.startsWith('@deepseek-ai/dsh-')) visit(dependency, packageRoot)
  }
}
for (const name of Object.keys(expected)) visit(name, root)
for (const [name, found] of versions) {
  if (found.size !== 1 || !found.has(target)) fail(`resolver-visible ${name} versions are ${[...found].join(', ')}, expected only ${target}`)
}
for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) {
  if (!versions.has(name)) fail(`resolver could not reach ${name}`)
}

if (errors.length) {
  console.error('INCOMPATIBLE')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`COMPATIBLE: DSH ${target}; Cordis ${expected['@deepseek-ai/cordis']}; Schemastery ${expected['@deepseek-ai/schemastery']}`)
}
