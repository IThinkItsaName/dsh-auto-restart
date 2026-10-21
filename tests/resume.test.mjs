import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverResume } from '../lib/resume.js'

let llmAvailable = true
try {
  await import('@deepseek-ai/dsh-llm')
} catch {
  llmAvailable = false
}

test('resume falls back to prompt() when the host has no resolveAgent', async () => {
  const outcome = await deliverResume(
    { sessionController: { prompt: async () => ({ accepted: true }) } },
    { sessionId: 'session-x', text: 'text', restartId: 'restart-x' },
  )
  assert.equal(outcome, 'unsupported')
})

test(
  'resume falls back when the message factory is unavailable',
  { skip: llmAvailable },
  async () => {
    // Outside the host the @deepseek-ai/dsh-llm package is not on the test
    // resolution path, so the dynamic import fails like an older host would.
    const agent = { status: 'idle', followup() {} }
    const controller = { resolveAgent: async () => ({ agent }) }
    const outcome = await deliverResume(
      { sessionController: controller },
      { sessionId: 'session-x', text: 'text', restartId: 'restart-x' },
    )
    assert.equal(outcome, 'unsupported')
  },
)
