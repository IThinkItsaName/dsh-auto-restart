import test from 'node:test'
import assert from 'node:assert/strict'
import { createStatusState } from '../lib/status-state.js'

test('reload requests are ordered and tokenized', () => {
  let clock = 1000
  const state = createStatusState(() => (clock += 10))
  const first = state.requestReload()
  const second = state.requestReload()
  assert.ok(second.reloadAt > first.reloadAt)
  assert.notEqual(second.reloadToken, first.reloadToken)
  assert.equal(state.snapshot().reloadAt, second.reloadAt)
})

test('draft hints are sanitized and capped', () => {
  const state = createStatusState(() => 42)
  const rows = Array.from({ length: 40 }, (_, index) => ({ sessionId: `s${index}`, lastUserText: `t${index}` }))
  rows.push({ sessionId: '', lastUserText: 'x' }, null, { lastUserText: 'x' })
  state.setDraftHints(rows)
  const snapshot = state.snapshot()
  assert.equal(snapshot.draftHints.at, 42)
  assert.equal(snapshot.draftHints.sessions.length, 32)
  assert.deepEqual(snapshot.draftHints.sessions[0], { sessionId: 's0', lastUserText: 't0' })
  assert.equal(snapshot.reloadAt, 0)
})

test('reload is gated and off until a gate opts in', () => {
  const state = createStatusState(() => 1)
  assert.equal(state.reloadEnabled(), false)
  state.setReloadGate(() => true)
  assert.equal(state.reloadEnabled(), true)
  state.setReloadGate(() => { throw new Error('boom') })
  assert.equal(state.reloadEnabled(), false)
})

test('page heartbeats expose a new boot id and poll count', () => {
  let clock = 10
  const state = createStatusState(() => (clock += 5))
  state.notePoll('boot-a')
  state.notePoll('boot-a')
  assert.deepEqual(state.snapshot().page, { bootId: 'boot-a', at: 20, polls: 2 })
  state.notePoll('boot-b')
  assert.deepEqual(state.snapshot().page, { bootId: 'boot-b', at: 25, polls: 1 })
  state.notePoll('')
  assert.equal(state.snapshot().page.bootId, 'boot-b')
})
