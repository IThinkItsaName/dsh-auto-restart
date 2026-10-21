import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as journal from '../lib/journal.js'

const HELPER = fileURLToPath(new URL('../lib/helper.mjs', import.meta.url))

test('dry-run helper acknowledges and never kills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-restart-helper-'))
  const root = join(dir, 'journal')
  try {
    const restartId = 'restart-helper-dry-run'
    const idDir = journal.restartDir(root, restartId)
    journal.createRequest(root, {
      version: 1,
      restartId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      hostPid: process.pid,
      desktopPid: undefined,
      reason: 'test',
      callers: [],
      others: [],
      launch: { mode: 'cli', executable: process.execPath, args: [], cwd: dir },
    })
    const result = spawnSync(process.execPath, [HELPER, idDir, '--dry-run'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0)
    const ack = JSON.parse(readFileSync(join(idDir, 'ack.json'), 'utf8'))
    assert.equal(ack.dryRun, true)
    assert.equal(ack.helperPid > 0, true)
    const dry = JSON.parse(readFileSync(join(idDir, 'dry-run.json'), 'utf8'))
    assert.equal(dry.helperPid, ack.helperPid)
    assert.equal(journal.hasMarker(idDir, 'killing'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
