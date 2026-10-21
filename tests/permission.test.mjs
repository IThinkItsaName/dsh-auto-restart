import test from 'node:test'
import assert from 'node:assert/strict'
import { permissionDecision, rankOf, normalizePolicy } from '../lib/permission.js'

test('mode ranking', () => {
  assert.equal(rankOf('read-only'), 0)
  assert.equal(rankOf('workspace-write'), 1)
  assert.equal(rankOf('danger-full-access'), 2)
  assert.equal(rankOf('unknown'), -1)
  assert.equal(normalizePolicy('bogus'), 'workspace-write')
})

test('workspace-write policy: workspace-write is self-service without confirm', () => {
  const decision = permissionDecision({
    policy: 'workspace-write',
    confirm: false,
    currentMode: 'workspace-write',
  })
  assert.equal(decision.escalationRequired, false)
  assert.equal(decision.approvalRequired, false)
})

test('workspace-write policy: read-only requires escalation approval', () => {
  const decision = permissionDecision({
    policy: 'workspace-write',
    confirm: false,
    currentMode: 'read-only',
  })
  assert.equal(decision.escalationRequired, true)
  assert.equal(decision.approvalRequired, true)
})

test('danger-full-access policy: workspace-write requires escalation approval even with confirm false', () => {
  const decision = permissionDecision({
    policy: 'danger-full-access',
    confirm: false,
    currentMode: 'workspace-write',
  })
  assert.equal(decision.escalationRequired, true)
  assert.equal(decision.approvalRequired, true)
})

test('danger-full-access policy: full access is self-service without confirm', () => {
  const decision = permissionDecision({
    policy: 'danger-full-access',
    confirm: false,
    currentMode: 'danger-full-access',
  })
  assert.equal(decision.escalationRequired, false)
  assert.equal(decision.approvalRequired, false)
})

test('confirm asks even when the mode is sufficient', () => {
  const decision = permissionDecision({
    policy: 'workspace-write',
    confirm: true,
    currentMode: 'danger-full-access',
  })
  assert.equal(decision.escalationRequired, false)
  assert.equal(decision.approvalRequired, true)
})
