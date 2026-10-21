import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'tool.js'), 'utf8')

test('dsh_restart description requires confirming necessity first', () => {
  assert.match(source, /confirm that a restart is actually required/)
  assert.match(source, /no simpler alternative/)
})
