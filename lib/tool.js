import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-dsh-auto-restart'

/**
 * The tool is mounted in the `cordis` preset only. It is a thin adapter over
 * the profile-level coordinator; no process or filesystem access lives here.
 */
export const inject = ['tools']

function quote(value) {
  const text = String(value ?? '')
  return text.length <= 180 ? text : `${text.slice(0, 179)}…`
}

function duration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
}

function renderResult(_args, value) {
  if (value?.ok === false) {
    return [{ type: 'text', text: `dsh_restart failed (${value.code ?? 'error'}): ${quote(value.message ?? 'unknown error')}` }]
  }
  if (value?.dryRun === true) {
    return [{
      type: 'text',
      text: `dsh_restart dry run: ${value.sessions ?? 0} active session(s) would be interrupted. Permission: ${value.permission?.policy ?? 'unknown'} in mode ${value.permission?.currentMode ?? 'unknown'}.`,
    }]
  }
  const parts = [
    `Restart scheduled: ${value?.restartId ?? 'unknown'}.`,
    `${value?.sessions ?? 0} active session(s) will be interrupted; the caller and other active sessions will be resumed after relaunch.`,
  ]
  if (value?.alreadyPending === true) parts.push('A restart was already pending; this session was added to the resume list.')
  if (value?.permission !== undefined) {
    parts.push(`Permission: ${value.permission.policy} (mode ${value.permission.currentMode}, escalation ${value.permission.escalationRequired ? 'required' : 'not required'}).`)
  }
  parts.push('Do not start new work or call other tools; the host will close shortly.')
  return [{ type: 'text', text: parts.join(' ') }]
}

export function apply(ctx) {
  if (ctx.get('dshRestart') === undefined) {
    ctx.logger('dsh-auto-restart').warn('tool mounted without the restart coordinator; dsh_restart will return unavailable')
  }
  const tool = defineTool({
    name: 'dsh_restart',
    description: [
      'Schedule a full DSH host restart. Use only when the user explicitly asks to restart after a plugin/config change, and only after saving work.',
      'Before calling, confirm that a restart is actually required to reach the goal and that no simpler alternative exists — reloading the changed component, editing config, starting a new session, or retrying usually is.',
      'This interrupts every active session, closes the desktop app or web host, and relaunches it. The calling session and other active sessions are resumed with a notice; idle sessions are left alone.',
      'The call may ask for approval (and, when the configured permission policy requires it, for a one-time escalation approval). Do not call it in plan mode, from a subagent, or in parallel with other tools.',
    ].join(' '),
    parameters: {
      reason: {
        type: 'string',
        required: true,
        description: 'Short human-readable reason for the restart (for the approval dialog and the caller resume notice).',
      },
      dryRun: {
        type: 'boolean',
        description: 'Only report the session snapshot, launch spec, and permission decision; do not write a journal or spawn a helper.',
      },
      force: {
        type: 'boolean',
        description: 'Bypass the post-restart cooldown. It never bypasses the permission or approval requirements.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderResult,
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const service = ctx.get('dshRestart')
      if (service === undefined || typeof service.request !== 'function') {
        return {
          ok: false,
          code: 'unavailable',
          message: 'The restart coordinator is not loaded in this profile.',
        }
      }
      return service.request({
        agent: exec.agent,
        reason: args.reason,
        callId: exec.callId,
        signal: exec.signal,
        dryRun: args.dryRun === true,
        force: args.force === true,
      })
    },
  })
  ctx.tools.register(tool)

  const reload = defineTool({
    name: 'dsh_reload',
    description: [
      'Refresh the DSH web UI without restarting the backend: the browser page reloads within about a second, so client-side plugin changes take effect while the host and the running conversation stay up.',
      'Disabled by default; enable it in Settings → Plugins → dsh-auto-restart before use. The call waits up to 4 s for a NEW page instance to check in and reports whether the reload actually landed, how long it took, and the last page-heartbeat age when it did not.',
      'Use it when only the browser half changed (a settings card, a UI plugin, a client bundle) and a full dsh_restart is unnecessary. The view may briefly lose the live stream; the agent turn keeps running and the final message is persisted.',
    ].join(' '),
    parameters: {
      reason: {
        type: 'string',
        description: 'Short human-readable reason for the reload (echoed in the tool result).',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (value?.ok !== true) {
          return [{ type: 'text', text: `dsh_reload failed: ${quote(value?.message ?? 'unknown error')}` }]
        }
        if (value.reloaded === true) {
          return [{
            type: 'text',
            text: `UI reloaded in ${value.elapsedMs} ms (new page ${quote(value.bootId)}). The host was not restarted (uptime ${duration(value.hostUptimeMs)}); the conversation keeps running.`,
          }]
        }
        const heartbeat = value.lastPollAgeMs === null || value.lastPollAgeMs === undefined
          ? 'no page heartbeat has ever been recorded'
          : `last page heartbeat ${value.lastPollAgeMs} ms ago`
        return [{
          type: 'text',
          text: `Reload requested, but no new page instance checked in within 4 s (${heartbeat}). The window may be disconnected or paused; reload it manually or use dsh_restart.`,
        }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const status = ctx.get('autoRestartStatus')
      if (status === undefined || typeof status.requestReload !== 'function') {
        return { ok: false, message: 'The restart coordinator is not loaded in this profile.' }
      }
      if (typeof status.reloadEnabled === 'function' && status.reloadEnabled() !== true) {
        return {
          ok: false,
          code: 'disabled',
          message: 'dsh_reload is disabled. Enable it in Settings → Plugins → dsh-auto-restart (「允许模型刷新页面」).',
        }
      }
      const before = status.snapshot?.().page?.bootId ?? ''
      const { reloadAt } = status.requestReload()
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        const page = status.snapshot?.().page
        if (page !== undefined && page.bootId !== '' && page.bootId !== before) {
          return {
            ok: true,
            reloaded: true,
            reloadAt,
            bootId: page.bootId,
            elapsedMs: Date.now() - reloadAt,
            hostUptimeMs: Math.round(process.uptime() * 1000),
            reason: args.reason,
          }
        }
      }
      const page = status.snapshot?.().page
      return {
        ok: true,
        reloaded: false,
        reloadAt,
        lastPollAgeMs: page?.at ? Date.now() - page.at : null,
        hostUptimeMs: Math.round(process.uptime() * 1000),
        reason: args.reason,
      }
    },
  })
  ctx.tools.register(reload)
}
