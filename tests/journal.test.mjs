import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as journal from '../lib/journal.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-auto-restart-journal-'))
}

test('lock is single-flight and stale locks are reclaimed', () => {
  const dir = tempRoot()
  const root = join(dir, 'journal')
  try {
    const first = journal.acquireLock(root, { pid: process.pid, restartId: 'restart-a', createdAt: 1 })
    assert.equal(first.acquired, true)
    const second = journal.acquireLock(root, { pid: process.pid + 1, restartId: 'restart-b', createdAt: 2 })
    assert.equal(second.acquired, false)
    journal.releaseLock(root, 'restart-a')
    const third = journal.acquireLock(root, { pid: process.pid, restartId: 'restart-c', createdAt: 3 })
    assert.equal(third.acquired, true)
    assert.equal(journal.isPidAlive(process.pid), true)
    assert.equal(journal.isPidAlive(99999999), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('request/markers/claim and active scan', () => {
  const dir = tempRoot()
  const root = join(dir, 'journal')
  try {
    const restartId = journal.makeRestartId(1000)
    const request = {
      restartId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      hostPid: process.pid,
      callers: [{ sessionId: 's1', callId: 'c1' }],
      others: [],
    }
    assert.equal(journal.findActive(root).length, 0)
    journal.createRequest(root, request)
    assert.equal(journal.readRequest(journal.restartDir(root, restartId)).restartId, restartId)
    assert.equal(journal.findActive(root).length, 0)
    journal.writeMarker(journal.restartDir(root, restartId), 'go', { ok: true })
    const active = journal.findActive(root)
    assert.equal(active.length, 1)
    assert.equal(active[0].request.restartId, restartId)
    assert.equal(journal.claimJournal(active[0].dir, { pid: process.pid }), true)
    assert.equal(journal.claimJournal(active[0].dir, { pid: process.pid + 1 }), false)
    journal.appendResult(active[0].dir, { sessionId: 's1', status: 'prompted' })
    journal.writeCompleted(active[0].dir, { status: 'completed' })
    assert.equal(journal.findActive(root).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('expired requests are not active', () => {
  const dir = tempRoot()
  const root = join(dir, 'journal')
  try {
    const restartId = 'restart-expired'
    const request = { restartId, createdAt: 1, expiresAt: 2, callers: [], others: [] }
    journal.createRequest(root, request)
    journal.writeMarker(journal.restartDir(root, restartId), 'go')
    assert.equal(journal.findActive(root).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
