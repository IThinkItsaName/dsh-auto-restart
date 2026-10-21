import test from 'node:test'
import assert from 'node:assert/strict'
import { clearStaleDraftJson, isStaleDraft } from '../lib/draft-guard.js'

test('a non-empty prefix of the last human message is stale', () => {
  assert.equal(isStaleDraft('可以，另外控制台输出', '可以，另外控制台输出的这一个错误一个警告是什么？'), true)
  assert.equal(isStaleDraft('可以，另外控制台输出的这一个错误一个警告是什么？', '可以，另外控制台输出的这一个错误一个警告是什么？'), true)
})

test('a real draft or a different message is not stale', () => {
  assert.equal(isStaleDraft('', '可以'), false)
  assert.equal(isStaleDraft('还没发的内容', '可以'), false)
  assert.equal(isStaleDraft('我想问一下', '那你可以直接重启嘛'), false)
  assert.equal(isStaleDraft('可以', ''), false)
  assert.equal(isStaleDraft(undefined, '可以'), false)
})

test('an IME snapshot ending in pinyin is stale when it shares a long prefix', () => {
  assert.equal(isStaleDraft('那你可以直接cho', '那你可以直接重启嘛'), true)
  assert.equal(isStaleDraft('插件规避吧。另外既然重启工具都做了，那么再ba', '插件规避吧。另外既然重启工具都做了，那么再把刷新工具也做一下'), true)
})

test('clearing a stale draft preserves the rest of the conversation entry', () => {
  const raw = JSON.stringify({
    draft: { text: '可以，另外', references: [] },
    view: 'chat',
    viewRequest: null,
  })
  const next = JSON.parse(clearStaleDraftJson(raw, '可以，另外控制台输出'))
  assert.deepEqual(next, { draft: { text: '', references: [] }, view: 'chat', viewRequest: null })
})

test('an untouched entry returns null', () => {
  const raw = JSON.stringify({ draft: { text: '真正没发的草稿', references: [] }, view: 'chat' })
  assert.equal(clearStaleDraftJson(raw, '可以'), null)
  assert.equal(clearStaleDraftJson('not json', '可以'), null)
  assert.equal(clearStaleDraftJson('[]', '可以'), null)
})

test('the legacy plain-string draft shape is cleared too', () => {
  const next = JSON.parse(clearStaleDraftJson(JSON.stringify({ draft: '可以', view: 'chat' }), '可以，另外'))
  assert.equal(next.draft, '')
  assert.equal(next.view, 'chat')
})
