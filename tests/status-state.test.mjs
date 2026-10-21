import test from 'node:test'
import assert from 'node:assert/strict'
import { createStatusState } from '../lib/status-state.js'

test('draft hints are sanitized and capped', () => {
  const state = createStatusState(() => 42)
  const rows = Array.from({ length: 40 }, (_, index) => ({ sessionId: `s${index}`, lastUserText: `t${index}` }))
  rows.push({ sessionId: '', lastUserText: 'x' }, null, { lastUserText: 'x' })
  state.setDraftHints(rows)
  const snapshot = state.snapshot()
  assert.equal(snapshot.draftHints.at, 42)
  assert.equal(snapshot.draftHints.sessions.length, 32)
  assert.deepEqual(snapshot.draftHints.sessions[0], { sessionId: 's0', lastUserText: 't0' })
})

test('an untouched state reports no hints', () => {
  const state = createStatusState(() => 1)
  assert.deepEqual(state.snapshot(), { draftHints: { at: 0, sessions: [] } })
})
