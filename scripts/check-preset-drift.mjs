#!/usr/bin/env node
/** Fail when the checked-in preset override no longer matches the shipped cordis preset. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildPatch, defaultSourcePath } from './gen-preset-override.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(process.argv[2] ?? defaultSourcePath())
const generatedPath = resolve(packageRoot, 'cordis.patch.yml')
const expected = buildPatch(readFileSync(sourcePath, 'utf8'), { sourceLabel: sourcePath })
const actual = readFileSync(generatedPath, 'utf8')
if (expected !== actual) {
  console.error('preset override drift detected; re-run scripts/gen-preset-override.mjs')
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  for (let index = 0; index < Math.max(expectedLines.length, actualLines.length); index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      console.error(`first difference at line ${index + 1}`)
      console.error(`  expected: ${expectedLines[index] ?? '<eof>'}`)
      console.error(`  actual:   ${actualLines[index] ?? '<eof>'}`)
      break
    }
  }
  process.exitCode = 1
} else {
  console.log(`preset override matches ${sourcePath}`)
}
