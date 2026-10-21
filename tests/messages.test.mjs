import test from 'node:test'
import assert from 'node:assert/strict'
import { composePrompt, callerPrompt, otherPrompt, defaultPromptFor, promptRequestId } from '../lib/messages.js'
import { marker } from '../lib/journal.js'

test('caller prompt always starts with the restart marker', () => {
  const text = callerPrompt('Please continue.\nReason: {{reason}}', {
    restartId: 'r1',
    reason: 'reload plugin',
    time: '2026-10-19T00:00:00Z',
  })
  assert.equal(text.startsWith(`${marker('r1')} `), true)
  assert.match(text, /reload plugin/u)
  assert.match(text, /Please continue\./u)
})

test('empty or whitespace prompt falls back to the default', () => {
  const text = composePrompt({ side: 'caller', template: '   ', restartId: 'r2', reason: 'x', time: 't' })
  assert.ok(text.includes(defaultPromptFor('caller').slice(0, 40)))
})

test('other prompt does not leak the caller reason', () => {
  const text = otherPrompt('Reason: {{reason}}\nContinue.', {
    restartId: 'r3',
    reason: 'secret caller reason',
    time: 't',
  })
  assert.equal(text.includes('secret caller reason'), false)
  assert.match(text, /another session requested it/u)
})

test('a user-provided marker is not duplicated', () => {
  const text = callerPrompt(`${marker('r4')} Continue here.`, { restartId: 'r4', reason: 'x', time: 't' })
  assert.equal(text.match(/\[dsh-auto-restart:r4\]/gu)?.length, 1)
})

test('request id and marker are deterministic', () => {
  assert.equal(promptRequestId('r5', 's1'), 'dsh-auto-restart:r5:s1')
  assert.equal(marker('r5'), '[dsh-auto-restart:r5]')
})
