import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWindowProbeScript, parseWindowCheckOutput, relaunchWindowsHide, windowCheckStatus } from '../lib/helper.mjs'

test('desktop relaunch must not hide the GUI window', () => {
  assert.equal(relaunchWindowsHide('desktop'), false)
  assert.equal(relaunchWindowsHide('cli'), true)
})

test('window probe output parser', () => {
  assert.deepEqual(parseWindowCheckOutput('visible|DSH — session'), {
    state: 'visible',
    visible: true,
    title: 'DSH — session',
  })
  assert.equal(parseWindowCheckOutput('hidden|').visible, false)
  assert.equal(parseWindowCheckOutput('unknown|').visible, null)
  assert.equal(parseWindowCheckOutput('missing|').visible, null)
  assert.equal(parseWindowCheckOutput('').state, 'unknown')
})

test('window probe keeps if/elseif/else in one PowerShell statement', () => {
  const script = buildWindowProbeScript(4242)
  assert.match(script, /Get-Process -Id 4242/)
  // A semicolon before `elseif`/`else` splits the chain: PowerShell then treats
  // the keyword as a command and exits 1 (0.1.1 always reported probe-failed).
  assert.doesNotMatch(script, /;\s*(?:elseif|else)\b/)
})

test(
  'window probe actually runs on Windows (regression: probe-failed)',
  { skip: process.platform !== 'win32' },
  () => {
    const result = windowCheckStatus(process.pid, 5000)
    assert.notEqual(result.state, 'probe-failed', result.error)
    assert.ok(
      ['visible', 'unknown', 'hidden', 'missing', 'powershell-missing'].includes(result.state),
      `unexpected probe state: ${result.state}`,
    )
  },
)
