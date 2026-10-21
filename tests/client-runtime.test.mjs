import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Boot the browser half in a sandbox with fake services. This catches runtime
 * errors that `node --check` cannot see (e.g. a name used outside its scope),
 * which matter here because a failing client entry aborts DSH's web boot.
 */
function boot({ fetchImpl, draft = '那你可以直接cho' }) {
  let definition
  const calls = { setDraft: [], urls: [], card: null }
  const context = {
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Promise,
    Number,
    String,
    Boolean,
    Error,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    document: {},
    fetch: async (url, init) => {
      calls.urls.push(String(url))
      return fetchImpl(url, init)
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  }
  context.window = {
    __ModuleLoader__: { load: (loaded) => { definition = loaded } },
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: {
        ...(props ?? {}),
        children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
      },
    }),
    useCallback: (fn) => fn,
    useState: (value) => [value, () => {}],
  }
  const mod = definition.factory((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Switch: () => null }
    throw new Error(`unexpected require: ${id}`)
  })
  const ctx = {
    effect: (fn) => { fn() },
    locale: { register: () => () => {} },
    configForms: {
      get: () => ({ set() {}, unset() {} }),
      whileServed: (_names, fn) => { fn(); return () => {} },
    },
    slots: {
      inject: (_name, fn) => { fn(); return () => {} },
      register: (_options, component) => { if (typeof component === 'function') calls.card = component; return () => {} },
    },
    get: (name) => name === 'conversation'
      ? { shell: () => ({ snapshot: { draft }, setDraft: (text) => { calls.setDraft.push(text) } }) }
      : undefined,
  }
  mod.apply(ctx)
  return { calls, mod }
}

test('client boot clears a stale IME draft from the status hints', async () => {
  const { calls } = boot({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        draftHints: {
          at: Date.now(),
          sessions: [{ sessionId: 's1', lastUserText: '那你可以直接重启嘛' }],
        },
      }),
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(calls.setDraft, [''])
  assert.equal(calls.urls[0], '/plugins/dsh-auto-restart/status.json')
})

function renderNode(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) renderNode(child)
    return
  }
  if (typeof node.type === 'function') {
    renderNode(node.type(node.props ?? {}))
    return
  }
  renderNode(node.props?.children)
}

test('settings card renders every row with the dsh-lore row layout', () => {
  const { calls } = boot({ fetchImpl: async () => ({ ok: false }) })
  assert.equal(typeof calls.card, 'function')
  const labels = []
  const element = calls.card({
    view: 'default',
    t: (key) => { labels.push(key); return key },
    useForm: (selector) => selector({
      status: 'ready',
      writable: true,
      value: {
        permissionPolicy: 'workspace-write',
        confirm: true,
        resumeOthers: true,
        callerResumePrompt: 'caller',
        otherResumePrompt: 'other',
      },
    }),
    save: async () => true,
    reset: async () => true,
  })
  renderNode(element)
  for (const key of ['permission.label', 'confirm.label', 'resumeOthers.label', 'caller.label', 'other.label']) {
    assert.ok(labels.includes(key), `missing label ${key}`)
  }
  assert.equal(labels.some((key) => key.startsWith('section.')), false, 'section headings were removed')
  assert.equal(labels.some((key) => key.startsWith('reload.')), false, 'reload row was removed')
})
