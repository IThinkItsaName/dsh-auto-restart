import test from 'node:test'
import assert from 'node:assert/strict'
import { jsonSafe } from '../lib/json.js'

test('jsonSafe drops undefined object fields and keeps arrays', () => {
  const value = jsonSafe({ ok: true, cwd: undefined, rows: [{ id: 's1', origin: undefined }] })
  assert.deepEqual(value, { ok: true, rows: [{ id: 's1' }] })
  assert.equal('cwd' in value, false)
  assert.equal('origin' in value.rows[0], false)
})

test('jsonSafe returns a structured error for cycles', () => {
  const value = { ok: true }
  value.self = value
  const safe = jsonSafe(value)
  assert.equal(safe.ok, false)
  assert.equal(safe.code, 'output-not-serializable')
})

test('jsonSafe does not mutate the input', () => {
  const input = { ok: true, nested: { keep: 1 } }
  const output = jsonSafe(input)
  output.nested.keep = 2
  assert.equal(input.nested.keep, 1)
})
