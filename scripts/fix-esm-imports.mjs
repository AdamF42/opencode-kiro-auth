#!/usr/bin/env node
/**
 * Postbuild script: adds .js extensions to relative imports in dist/ files.
 * Fixes ESM compatibility for strict runtimes (Bun 1.3.13+, Node.js).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT_DIR = resolve(import.meta.dirname, '..')
const SRC_DIR = join(ROOT_DIR, 'src')
const DIST_DIR = join(ROOT_DIR, 'dist')

function walk(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...walk(full))
    } else if (full.endsWith('.js') || full.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

// Match: from './foo' or from '../foo' (but NOT from './foo.js' or from 'zod')
const IMPORT_RE = /(from\s+['"])(\.[^'"]*?)(?<!\.[cm]?js)(['"])/g

function fixFile(filePath) {
  const original = readFileSync(filePath, 'utf-8')
  let changed = false

  const fixed = original.replace(IMPORT_RE, (match, prefix, specifier, suffix) => {
    if (specifier.endsWith('.js')) return match

    const dir = dirname(filePath)

    // Check if specifier points to a directory with index.js
    const asDir = resolve(dir, specifier)
    if (existsSync(join(asDir, 'index.js'))) {
      changed = true
      return `${prefix}${specifier}/index.js${suffix}`
    }

    // Check if specifier.js exists
    if (existsSync(resolve(dir, specifier + '.js'))) {
      changed = true
      return `${prefix}${specifier}.js${suffix}`
    }

    return match
  })

  if (changed) {
    writeFileSync(filePath, fixed, 'utf-8')
  }
  return changed
}

const files = walk(DIST_DIR)
let fixedCount = 0
for (const f of files) {
  if (fixFile(f)) fixedCount++
}
console.log(`fix-esm-imports: patched ${fixedCount}/${files.length} files in dist/`)

// Copy non-TS runtime assets (e.g. the .mjs MCP bridge) that tsc does not emit,
// preserving their path relative to src/ so import.meta.url resolution keeps working.
function copyMjsAssets(dir) {
  let copied = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      copied += copyMjsAssets(full)
    } else if (full.endsWith('.mjs')) {
      const dest = join(DIST_DIR, relative(SRC_DIR, full))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(full, dest)
      copied++
    }
  }
  return copied
}

if (existsSync(SRC_DIR)) {
  const copied = copyMjsAssets(SRC_DIR)
  console.log(`fix-esm-imports: copied ${copied} .mjs asset(s) into dist/`)
}
