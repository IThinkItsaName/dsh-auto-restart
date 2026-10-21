import test from 'node:test'
import assert from 'node:assert/strict'
import { noticeMessageInput } from '../lib/notice.js'

test('resume notice uses a notice source instead of a human user source', () => {
  const input = noticeMessageInput({ text: '[dsh-auto-restart:restart-abc] DSH restarted', restartId: 'restart-abc' })
  assert.deepEqual(input.content, [{ type: 'text', text: '[dsh-auto-restart:restart-abc] DSH restarted' }])
  assert.equal(input.source.kind, 'dsh-auto-restart')
  assert.equal(input.source.form, 'notice')
  assert.match(input.source.summary, /restart-abc/)
  // createUserMessage() adds role/identity; the input must not carry a user role
  // or the Chat would classify it as a human turn again.
  assert.equal('role' in input, false)
})
