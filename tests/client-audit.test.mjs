import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
const tool = readFileSync(fileURLToPath(new URL('../lib/tool.js', import.meta.url)), 'utf8')

test('client card uses the official configForms/slot path', () => {
  assert.match(client, /plugins\.bundle\.config/u)
  assert.match(client, /ctx\.configForms/u)
  assert.match(client, /forms\.whileServed/u)
})

test('client polls exactly one read-only status route, for draft hints only', () => {
  const route = readFileSync(fileURLToPath(new URL('../lib/status-route.js', import.meta.url)), 'utf8')
  assert.match(route, /\/plugins\/dsh-auto-restart\/status\.json/u)
  assert.equal((client.match(/fetch\(/gu) ?? []).length, 1, 'client must have exactly one fetch')
  assert.match(client, /fetch\(STATUS_URL/u)
  assert.match(client, /draftHints/u)
  assert.equal(/location\.reload/u.test(client), false, 'the reload feature was removed')
  assert.equal(/reloadAt/u.test(client), false, 'the reload feature was removed')
})

test('settings fields are present in both halves', () => {
  for (const field of ['permissionPolicy', 'confirm', 'resumeOthers', 'callerResumePrompt', 'otherResumePrompt']) {
    assert.ok(client.includes(field), `client missing ${field}`)
    assert.ok(host.includes(field), `host missing ${field}`)
  }
})

test('no reload tool or setting is shipped', () => {
  assert.equal(/dsh_reload/u.test(tool), false)
  assert.equal(/reloadEnabled/u.test(host), false)
  assert.equal(/reloadEnabled/u.test(client), false)
})

test('the settings card is a single-level list', () => {
  assert.equal(/section\./u.test(client), false)
  assert.equal(/note\.live|note\.admission/u.test(client), false)
})

test('host marks runtime settings volatile', () => {
  const matches = host.match(/\.volatile\(\)/gu) ?? []
  assert.ok(matches.length >= 5, `expected at least 5 volatile fields, found ${matches.length}`)
  assert.match(host, /callerResumePrompt: z\.string\(\)\.default\(DEFAULT_CALLER_PROMPT\)\.volatile\(\)/u)
  assert.match(host, /otherResumePrompt: z\.string\(\)\.default\(DEFAULT_OTHER_PROMPT\)\.volatile\(\)/u)
})
