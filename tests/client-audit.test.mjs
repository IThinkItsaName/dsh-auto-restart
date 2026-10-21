import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

test('client card uses the official configForms/slot path', () => {
  assert.match(client, /plugins\.bundle\.config/u)
  assert.match(client, /ctx\.configForms/u)
  assert.match(client, /forms\.whileServed/u)
})

test('client polls exactly one read-only status route, and reloads only on request', () => {
  const route = readFileSync(fileURLToPath(new URL('../lib/status-route.js', import.meta.url)), 'utf8')
  assert.match(route, /\/plugins\/dsh-auto-restart\/status\.json/u)
  assert.equal((client.match(/fetch\(/gu) ?? []).length, 1, 'client must have exactly one fetch')
  assert.match(client, /fetch\(`\$\{STATUS_URL\}/u)
  assert.match(client, /data\.reloadAt > PAGE_STARTED_AT/u)
  assert.match(client, /location\.reload/u)
  assert.match(client, /draftHints/u)
})

test('settings fields are present in both halves', () => {
  for (const field of ['permissionPolicy', 'confirm', 'resumeOthers', 'reloadEnabled', 'callerResumePrompt', 'otherResumePrompt']) {
    assert.ok(client.includes(field), `client missing ${field}`)
    assert.ok(host.includes(field), `host missing ${field}`)
  }
})

test('reload is gated by an opt-in setting, off by default', () => {
  assert.match(host, /reloadEnabled: z\.boolean\(\)\.default\(false\)\.volatile\(\)/u)
  assert.match(host, /setReloadGate/u)
})

test('client sends a per-page boot id so the host can confirm a reload', () => {
  assert.match(client, /\?boot=/u)
  assert.match(client, /PAGE_BOOT_ID/u)
})

test('host marks runtime settings volatile', () => {
  const matches = host.match(/\.volatile\(\)/gu) ?? []
  assert.ok(matches.length >= 5, `expected at least 5 volatile fields, found ${matches.length}`)
  assert.match(host, /callerResumePrompt: z\.string\(\)\.default\(DEFAULT_CALLER_PROMPT\)\.volatile\(\)/u)
  assert.match(host, /otherResumePrompt: z\.string\(\)\.default\(DEFAULT_OTHER_PROMPT\)\.volatile\(\)/u)
})
