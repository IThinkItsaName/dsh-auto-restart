/**
 * dsh-auto-restart settings card (browser half).
 *
 * Hand-written plain JavaScript, no build step: the wrapper is the standard
 * `window.__ModuleLoader__.load` form used by the shipped client packages.
 * Configuration travels through `ctx.configForms`; the only network use is the
 * read-only host status route that reports post-restart draft hints.
 * The layout mirrors dsh-lore's settings card: single-level label/control rows
 * with `--dsw-*` tokens, and the official Switch primitive.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-restart',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useState } = React

    /** Official switch primitive; degrade to a checkbox if a host lacks it. */
    let Switch = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives !== null && typeof primitives === 'object' && typeof primitives.Switch === 'function') {
        Switch = primitives.Switch
      }
    } catch (_error) {
      Switch = null
    }
    const Toggle = Switch ?? ((props) => h('input', {
      type: 'checkbox',
      checked: props.checked === true,
      disabled: props.disabled,
      onChange: (event) => { if (typeof props.onChange === 'function') props.onChange(event.target.checked) },
    }))

    const NS = 'dsh-auto-restart'
    const FORM_FIELDS = [
      'permissionPolicy',
      'confirm',
      'resumeOthers',
      'callerResumePrompt',
      'otherResumePrompt',
    ]

    const DICT_ZH = {
      summary: 'DSH 自动重启设置',
      title: '自动重启',
      intro: '控制 dsh_restart 的准入策略，以及重启后调用方与其他会话的续跑提示。保存后即时生效，不需要重启 DSH。',
      'permission.label': '权限策略',
      'permission.workspace': '工作区内即可自行使用（workspace-write 或更高）',
      'permission.danger': '仅 danger-full-access 下免提权（低权限会话会先请求一次提权批准）',
      'confirm.label': '重启前仍确认一次（推荐）',
      'confirm.hint': '关闭它，达到权限级别后才会真正“自行使用”；低权限的提权批准不受此开关影响。',
      'resumeOthers.label': '恢复其他活动会话',
      'resumeOthers.hint': '关闭后只恢复调用方；其他会话仍会被打断和记录，但不会自动续跑。',
      'caller.label': '调用方续跑提示词',
      'caller.hint': '支持 {{restartId}}、{{reason}}、{{time}}。marker 由宿主自动加，不需要手写。',
      'other.label': '其他会话续跑提示词',
      'other.hint': '支持 {{restartId}}、{{time}}；{{reason}} 会被替换为“another session requested it”，不会泄露调用方原因。',
      save: '保存',
      reset: '恢复默认',
      saved: '已保存',
      rejected: '宿主拒绝了这次写入（可能有更高层覆盖）',
      error: '写入失败',
      pending: '保存中…',
      loading: '正在读取设置…',
      unavailable: '设置命名空间尚未出现：宿主半边未加载，或 bundle id 不是 dsh-auto-restart。',
      readonly: '当前 profile 的设置为只读（被更高层覆盖）。',
      'prompt.placeholder': '输入续跑提示正文…',
    }

    const DICT_EN = {
      summary: 'DSH auto-restart settings',
      title: 'Auto restart',
      intro: 'Admission policy for dsh_restart and the resume notices used after a restart. Saved values apply immediately; no DSH restart is needed.',
      'permission.label': 'Permission policy',
      'permission.workspace': 'Usable within workspace-write (workspace-write or higher)',
      'permission.danger': 'No escalation only under danger-full-access (lower modes ask once for escalation)',
      'confirm.label': 'Still confirm before each restart (recommended)',
      'confirm.hint': 'Turn it off to allow self-service once the permission level is met. Escalation approval in lower modes is independent of this switch.',
      'resumeOthers.label': 'Resume other active sessions',
      'resumeOthers.hint': 'When off, only the caller is resumed. Other sessions are still interrupted and recorded.',
      'caller.label': 'Caller resume prompt',
      'caller.hint': 'Supports {{restartId}}, {{reason}}, {{time}}. The marker is prepended by the host.',
      'other.label': 'Other-session resume prompt',
      'other.hint': 'Supports {{restartId}}, {{time}}. {{reason}} becomes “another session requested it” to avoid leaking the caller reason.',
      save: 'Save',
      reset: 'Reset',
      saved: 'Saved',
      rejected: 'The host rejected the write (a higher layer may override this value).',
      error: 'Write failed',
      pending: 'Saving…',
      loading: 'Reading settings…',
      unavailable: 'The settings namespace is absent: the host half is not loaded, or the bundle id is not dsh-auto-restart.',
      readonly: 'Settings are read-only in this profile (overridden by a higher layer).',
      'prompt.placeholder': 'Resume prompt body…',
    }

    /* ---------------------------------------------------------------- 样式 --
     * 与 dsh-lore 设置卡片同一套语言：只用 `--dsw-*` token 和行内样式；
     * 单层列表——标签在左、控件在右、行下 0.5px 分隔线。 */
    const S = {
      root: { display: 'flex', flexDirection: 'column', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)' },
      row: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '24px', padding: '14px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      },
      rowLast: { borderBottom: 'none' },
      rowStacked: { flexDirection: 'column', alignItems: 'stretch', gap: '8px' },
      labelBlock: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      control: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' },
      controlStacked: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '6px', width: '100%' },
      label: { fontSize: '14px', lineHeight: '20px' },
      hint: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      note: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      status: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      statusError: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-error)' },
      readonly: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      select: {
        minWidth: '240px', maxWidth: '320px', padding: '6px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'inherit', font: 'inherit',
      },
      textarea: {
        width: '100%', minHeight: '88px', resize: 'vertical', padding: '8px 10px',
        borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'inherit', font: 'inherit', lineHeight: '20px',
      },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      button: {
        font: 'inherit', fontSize: '12px', padding: '4px 12px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
      },
    }

    function SettingsCard(props) {
      const fallbackT = useCallback((key) => (DICT_ZH[key] === undefined ? key : DICT_ZH[key]), [])
      const t = typeof props?.t === 'function' ? props.t : fallbackT
      const useForm = typeof props?.useForm === 'function' ? props.useForm : () => undefined
      const snapshot = useForm((value) => value)
      const [drafts, setDrafts] = useState({})
      const [notice, setNotice] = useState(null)

      if (props?.view === 'summary') return h('span', null, t('summary'))

      const status = snapshot?.status
      const ready = status === 'ready'
      const writable = ready && snapshot?.writable !== false
      const value = snapshot?.value ?? {}
      const disabled = !writable || notice?.kind === 'pending'

      const say = (kind) => setNotice({ kind })
      const saveField = async (field, nextValue) => {
        if (!writable || typeof props.save !== 'function') return
        say('pending')
        try {
          const accepted = await props.save(field, nextValue)
          setDrafts((previous) => {
            const copy = { ...previous }
            delete copy[field]
            return copy
          })
          say(accepted === false ? 'rejected' : 'saved')
        } catch {
          say('error')
        }
      }
      const resetField = async (field) => {
        if (!writable || typeof props.reset !== 'function') return
        say('pending')
        try {
          const accepted = await props.reset(field)
          setDrafts((previous) => {
            const copy = { ...previous }
            delete copy[field]
            return copy
          })
          say(accepted === false ? 'rejected' : 'saved')
        } catch {
          say('error')
        }
      }
      const textValue = (field) => (drafts[field] !== undefined ? drafts[field] : (value[field] ?? ''))
      const editText = (field, text) => setDrafts((previous) => ({ ...previous, [field]: text }))

      const noticeText = notice === null ? null
        : notice.kind === 'pending' ? t('pending')
          : notice.kind === 'saved' ? t('saved')
            : notice.kind === 'rejected' ? t('rejected')
              : t('error')
      const noticeStyle = notice !== null && (notice.kind === 'rejected' || notice.kind === 'error')
        ? S.statusError
        : notice?.kind === 'saved' ? S.status : S.hint

      if (!ready) {
        return h('div', { style: S.root },
          h('p', { key: 'status', style: S.status }, status === 'loading' ? t('loading') : t('unavailable')),
        )
      }

      /** One settings row: label + hint on the left, control on the right. */
      const row = (key, labelKey, hintKey, control, options = {}) => h('div', {
        key,
        style: {
          ...S.row,
          ...(options.last === true ? S.rowLast : {}),
          ...(options.stacked === true ? S.rowStacked : {}),
        },
      },
        h('div', { style: S.labelBlock },
          h('div', { style: S.label }, t(labelKey)),
          hintKey === null ? null : h('p', { style: S.hint }, t(hintKey)),
        ),
        options.stacked === true
          ? h('div', { style: S.controlStacked }, control)
          : h('div', { style: S.control }, control),
      )

      const switchRow = (key, field, labelKey, hintKey, defaultOn, last = false) => row(
        key,
        labelKey,
        hintKey,
        h(Toggle, {
          label: t(labelKey),
          checked: defaultOn ? value[field] !== false : value[field] === true,
          disabled,
          onChange: (next) => { void saveField(field, next) },
        }),
        { last },
      )

      const promptRows = ['callerResumePrompt', 'otherResumePrompt'].map((field, index, all) => {
        const caller = field === 'callerResumePrompt'
        return row(
          field,
          caller ? 'caller.label' : 'other.label',
          caller ? 'caller.hint' : 'other.hint',
          [
            h('textarea', {
              key: 'input',
              id: `dsh-ar-${field}`,
              style: S.textarea,
              value: textValue(field),
              placeholder: t('prompt.placeholder'),
              disabled,
              onChange: (event) => editText(field, event.target.value),
            }),
            h('div', { key: 'actions', style: S.actions },
              h('button', {
                type: 'button',
                style: S.button,
                disabled,
                onClick: () => { void saveField(field, textValue(field)) },
              }, t('save')),
              h('button', {
                type: 'button',
                style: S.button,
                disabled,
                onClick: () => { void resetField(field) },
              }, t('reset')),
            ),
          ],
          { stacked: true, last: index === all.length - 1 },
        )
      })

      const children = []
      if (!writable) children.push(h('p', { key: 'readonly', style: S.readonly }, t('readonly')))
      children.push(
        row('permission', 'permission.label', null, h('select', {
          'aria-label': t('permission.label'),
          style: S.select,
          value: value.permissionPolicy ?? 'workspace-write',
          disabled,
          onChange: (event) => { void saveField('permissionPolicy', event.target.value) },
        },
          h('option', { value: 'workspace-write' }, t('permission.workspace')),
          h('option', { value: 'danger-full-access' }, t('permission.danger')),
        )),
        switchRow('confirm', 'confirm', 'confirm.label', 'confirm.hint', true),
        switchRow('resumeOthers', 'resumeOthers', 'resumeOthers.label', 'resumeOthers.hint', true),
        ...promptRows,
      )
      if (noticeText !== null) children.push(h('p', { key: 'notice', style: noticeStyle }, noticeText))
      return h('div', { style: S.root }, children)
    }

    const inject = ['locale', 'slots', 'configForms']

    // ── post-restart draft cleanup ──────────────────────────────────────────
    // The host exposes a read-only status route describing the drafts the last
    // restart left stale (a prefix of the session's last human message, or an
    // IME snapshot sharing a long prefix). Poll it after load until it answers.
    const STATUS_URL = '/plugins/dsh-auto-restart/status.json'

    function commonPrefixLength(left, right) {
      const a = Array.from(left)
      const b = Array.from(right)
      const max = Math.min(a.length, b.length)
      let index = 0
      while (index < max && a[index] === b[index]) index += 1
      return index
    }

    function isStaleDraftText(draftText, lastUserText) {
      if (typeof draftText !== 'string' || draftText === '') return false
      if (typeof lastUserText !== 'string' || lastUserText === '') return false
      if (lastUserText.startsWith(draftText)) return true
      // The final IME snapshot can end in unconverted pinyin ("…直接cho").
      return commonPrefixLength(draftText, lastUserText) >= 4
    }

    function clearDraftForSession(ctx, row) {
      const lastUserText = typeof row?.lastUserText === 'string' ? row.lastUserText : ''
      const sessionId = typeof row?.sessionId === 'string' ? row.sessionId : ''
      if (lastUserText === '' || sessionId === '') return
      try {
        const conversation = ctx.get('conversation')
        const shell = conversation?.shell?.(sessionId)
        const current = shell?.snapshot?.draft
        if (isStaleDraftText(current, lastUserText)) {
          shell.setDraft('')
          return
        }
      } catch (_error) {
        // Fall through to the persisted copy.
      }
      try {
        if (typeof localStorage === 'undefined') return
        const key = 'dsh.conversation.' + sessionId
        const raw = localStorage.getItem(key)
        if (raw === null) return
        const stored = JSON.parse(raw)
        if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return
        const draft = stored.draft
        const current = typeof draft === 'string' ? draft : draft?.text
        if (!isStaleDraftText(current, lastUserText)) return
        const nextDraft = typeof draft === 'string' ? '' : { ...(draft ?? {}), text: '', references: [] }
        localStorage.setItem(key, JSON.stringify({ ...stored, draft: nextDraft }))
      } catch (_error) {
        // Best-effort cleanup only.
      }
    }

    function startDraftHintWatch(ctx, onDraftCleared) {
      if (typeof window === 'undefined' || typeof fetch !== 'function' || typeof document === 'undefined') return
      let timer = null
      let attempts = 0
      const stop = () => {
        if (timer !== null) {
          window.clearInterval(timer)
          timer = null
        }
      }
      const tick = async () => {
        try {
          const response = await fetch(STATUS_URL, { cache: 'no-store', credentials: 'same-origin' })
          if (!response.ok) return
          const data = await response.json()
          if (data === null || typeof data !== 'object') return
          const hints = data.draftHints
          const sessions = Array.isArray(hints?.sessions) ? hints.sessions : []
          const hintsAt = Number(hints?.at) || 0
          if (sessions.length === 0 || hintsAt === 0) return
          stop()
          // Older hints may describe a draft the user has since retyped; only
          // clean up right after the restart that produced them.
          if (Date.now() - hintsAt >= 30 * 60_000) return
          for (const row of sessions) clearDraftForSession(ctx, row)
          if (typeof onDraftCleared === 'function') onDraftCleared()
        } catch (_error) {
          // The watcher must never break the page (a failing client entry
          // aborts DSH's whole web boot).
        }
      }
      void tick()
      timer = window.setInterval(() => {
        attempts += 1
        if (attempts >= 90) stop()
        void tick()
      }, 2000)
      window.addEventListener('pagehide', stop, { once: true })
    }

    function apply(ctx) {
      try {
        startDraftHintWatch(ctx)
      } catch (_error) {
        // A client-side watcher failure must not fail this plugin entry.
      }
      const locale = ctx.locale
      ctx.effect(
        () => locale.register(NS, { zh: DICT_ZH, en: DICT_EN }),
        'dsh-auto-restart: settings dictionaries',
      )

      const forms = ctx.configForms
      ctx.effect(
        () => forms.whileServed([NS], () => ctx.slots.inject('plugins.bundle.config', () => {
          const form = forms.get(NS)
          return ctx.slots.register({
            name: 'plugins.bundle.config',
            key: NS,
            locale: NS,
            inject: () => ({
              hooks: { form },
              save: (field, nextValue) => form.set(field, nextValue),
              reset: (field) => form.unset(field),
            }),
          }, SettingsCard)
        })),
        'dsh-auto-restart: plugins page card',
      )
    }

    exports.name = 'dsh-auto-restart'
    exports.inject = inject
    exports.apply = apply
    exports.FORM_FIELDS = FORM_FIELDS
    return module.exports
  },
})
