import { Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as journal from './journal.js'
import { detectLaunch, spawnHelper, waitForAck } from './launch.js'
import { approvalReason, permissionDecision } from './permission.js'
import { composePrompt, defaultPromptFor, promptHash, promptRequestId } from './messages.js'
import { jsonSafe } from './json.js'
import { resumeJournal } from './resume.js'

const HELPER_PATH = fileURLToPath(new URL('./helper.mjs', import.meta.url))
const DEFAULT_GO_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000
const DEFAULT_RELAUNCH_DELAY_MS = 1_500
const DEFAULT_RELAUNCH_WAIT_MS = 60_000
const DEFAULT_EXPIRY_MS = 10 * 60 * 1000

function live(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const resolved = value.get()
      return resolved === undefined || resolved === null ? fallback : resolved
    } catch {
      return fallback
    }
  }
  return value === undefined || value === null ? fallback : value
}

function sleep(ms) {
  return journal.sleep(ms)
}

function timeoutAfter(ms, label) {
  return sleep(ms).then(() => ({ timedOut: true, label }))
}

async function settleWithin(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    timeoutAfter(ms, label),
  ])
}

function errorResult(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

function callerRecord(agent, callId) {
  return {
    sessionId: agent.id,
    callId,
    cwd: agent.session?.header?.cwd,
    snapshotSeq: agent.session?.seq,
    at: new Date().toISOString(),
  }
}

function otherRecord(agent, jobs) {
  return {
    sessionId: agent.id,
    cwd: agent.session?.header?.cwd,
    status: agent.status,
    pendingInput: (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0),
    runningJobs: jobs,
    snapshotSeq: agent.session?.seq,
    origin: agent.session?.header?.origin,
  }
}

/**
 * Profile-level restart coordinator.
 *
 * The service is intentionally thin at construction: it waits for the core
 * session services through `ctx.inject` before touching live agents, so a
 * broken optional plugin cannot prevent the host from starting.
 */
export class AutoRestartService extends Service {
  constructor(ctx, config, status) {
    super(ctx, 'dshRestart')
    this.config = config
    this.status = status
    this.logger = ctx.logger('dsh-auto-restart')
    this.root = journal.defaultRoot(live(config.journalDir, ''))
    this.active = null
    this.pendingCalls = new Map()
    this.noResultTimer = undefined
    this.watchdogTimer = undefined
    this.draining = false
    this.disposed = false
    // The injected child scope is the one that can resolve services provided
    // by sibling host groups (notably sessionController/webServer). Keep it
    // for every runtime lookup; `this.ctx` is only used for lifecycle events.
    this.runtimeCtx = undefined

    ctx.on('connection/request', (request, response, next) => {
      if (!this.draining) return next()
      try {
        response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('DSH is restarting; retry after the new host is ready.')
      } catch {
        // The response may already be gone; never crash the host.
      }
      return undefined
    })

    ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    })

    ctx.effect(() => () => this.dispose(), 'dsh-auto-restart: service lifetime')

    ctx.inject(['sessionController', 'sessions', 'agents'], (scope) => {
      scope.effect(() => {
        void this.onReady(scope)
        return () => {}
      }, 'dsh-auto-restart: startup resume')
    })
  }

  runtime() {
    return this.runtimeCtx ?? this.ctx
  }

  async onReady(scope) {
    if (this.disposed) return
    if (scope !== undefined) this.runtimeCtx = scope
    try {
      journal.prune(this.root)
    } catch (error) {
      this.logger.warn(`prune failed: ${String(error?.message ?? error)}`)
    }
    let active = []
    try {
      active = journal.findActive(this.root)
    } catch (error) {
      this.logger.warn(`journal scan failed: ${String(error?.message ?? error)}`)
    }
    for (const entry of active) {
      try {
        const outcome = await resumeJournal({
          ctx: this.runtime(),
          config: this.config,
          dir: entry.dir,
          request: entry.request,
          logger: this.logger,
          root: this.root,
        })
        if (Array.isArray(outcome?.draftHints) && outcome.draftHints.length > 0) {
          this.status?.setDraftHints?.(outcome.draftHints)
        }
      } catch (error) {
        this.logger.warn(`resume ${entry.request?.restartId ?? entry.dir} failed: ${String(error?.message ?? error)}`)
      }
    }
  }

  status() {
    if (this.active !== null) {
      return {
        pending: true,
        restartId: this.active.request.restartId,
        phase: this.active.phase,
        dir: this.active.dir,
      }
    }
    const entry = journal.findActive(this.root)[0]
    return entry === undefined
      ? { pending: false }
      : { pending: true, restartId: entry.request.restartId, phase: 'disk', dir: entry.dir }
  }

  currentMode(agent) {
    const sandboxPolicy = this.runtime().get('sandboxPolicy')
    if (sandboxPolicy === undefined || typeof sandboxPolicy.resolve !== 'function') return 'read-only'
    try {
      return sandboxPolicy.resolve({ session: agent.session })?.mode ?? 'read-only'
    } catch {
      return 'read-only'
    }
  }

  jobsFor(sessionId) {
    const jobs = this.runtime().get('jobs')
    if (jobs === undefined || typeof jobs.list !== 'function') return 0
    try {
      return jobs.list(sessionId).filter((job) => job.status === 'running' || job.status === 'stopping').length
    } catch {
      return 0
    }
  }

  async reminderCount(agent) {
    try {
      const entries = await this.ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([]))
      return entries.filter((entry) => entry?.kind === 'schedule').length
    } catch {
      return 0
    }
  }

  async snapshot(caller, resumeOthers) {
    const agents = this.runtime().get('agents')
    const list = agents?.list?.() ?? []
    const callers = [callerRecord(caller, this.pendingCallId ?? undefined)]
    const others = []
    let runningJobs = 0
    let reminders = 0
    for (const agent of list) {
      if (agent.id === caller.id) continue
      if (agent.session?.header?.origin === 'subagent') continue
      const pendingInput = (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0)
      const jobs = this.jobsFor(agent.id)
      runningJobs += jobs
      if (agent.status !== 'running' && pendingInput === 0) continue
      others.push(otherRecord(agent, jobs))
      reminders += await this.reminderCount(agent)
    }
    if (resumeOthers !== true) {
      // Keep the records for auditing; the resumer uses this flag.
    }
    return {
      callers,
      others,
      activeSessions: callers.length + others.length,
      runningJobs,
      reminders,
      resumeOthers: resumeOthers === true,
    }
  }

  async request({ agent, reason, callId, signal, dryRun = false, force = false } = {}) {
    try {
      return jsonSafe(await this.requestUnsafe({ agent, reason, callId, signal, dryRun, force }))
    } catch (error) {
      this.logger.error(`restart request failed: ${String(error?.stack ?? error)}`)
      return jsonSafe(errorResult('internal-error', String(error?.message ?? error)))
    }
  }

  async requestUnsafe({ agent, reason, callId, signal, dryRun, force }) {
    if (this.disposed) return errorResult('disposed', 'The restart coordinator is disposed.')
    if (live(this.config.enabled, true) !== true) return errorResult('disabled', 'The restart tool is disabled by config.')
    if (agent === undefined || agent === null) return errorResult('no-caller', 'No calling agent is available.')
    if (agent.session?.header?.origin === 'subagent') {
      return errorResult('subagent', 'dsh_restart can only be called from a top-level session, not a subagent.')
    }
    if (signal?.aborted === true) return errorResult('cancelled', 'The call was cancelled before scheduling.')
    const cleanReason = String(reason ?? '').trim()
    if (cleanReason === '') return errorResult('invalid-reason', 'reason must be a non-empty string.')
    if (cleanReason.length > 500) return errorResult('invalid-reason', 'reason must be at most 500 characters.')

    const planMode = this.runtime().get('planMode')
    if (planMode?.get?.(agent)?.active === true) {
      return errorResult('plan-mode', 'Exit plan mode before requesting a DSH restart.')
    }

    let active = this.active
    if (active === null) {
      const disk = journal.findActive(this.root)[0]
      if (disk !== undefined) {
        active = this.loadActive(disk)
      }
    }
    if (active !== null) {
      if (active.phase === 'go' || active.phase === 'killing' || active.phase === 'relaunching' || active.phase === 'quiescing') {
        return errorResult('restart-in-progress', 'A DSH restart is already in progress.', { restartId: active.request.restartId })
      }
      this.addCaller(active, agent, callId)
      return {
        ok: true,
        scheduled: true,
        alreadyPending: true,
        restartId: active.request.restartId,
        sessions: active.request.callers.length + active.request.others.length,
        permission: active.request.permission,
        message: 'A restart is already pending; this session was added to the resume list.',
      }
    }

    const state = journal.readState(this.root)
    const cooldownMs = live(this.config.cooldownMs, 60_000)
    const completedAt = Number(state?.lastCompletedAt)
    if (force !== true && Number.isFinite(completedAt) && Date.now() - completedAt < cooldownMs) {
      return errorResult('cooldown', `A restart completed ${Math.ceil((Date.now() - completedAt) / 1000)}s ago; wait or pass force.`)
    }

    this.pendingCallId = callId ?? `call-${randomUUID()}`
    const resumeOthers = live(this.config.resumeOthers, true) === true
    const preliminary = await this.snapshot(agent, resumeOthers)
    const policy = live(this.config.permissionPolicy, 'workspace-write')
    const confirm = live(this.config.confirm, true) === true
    const decision = permissionDecision({ policy, confirm, currentMode: this.currentMode(agent) })

    if (dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        scheduled: false,
        permission: decision,
        sessions: preliminary.activeSessions,
        details: preliminary,
        message: `Dry run: ${preliminary.activeSessions} session(s) would be interrupted; permission ${decision.policy} in mode ${decision.currentMode}.`,
      }
    }

    if (decision.approvalRequired) {
      const approval = this.runtime().get('approval')
      if (approval === undefined || typeof approval.request !== 'function') {
        return errorResult('needs-approval', 'This call requires approval, but no approval service is available.', { permission: decision })
      }
      const outcome = await approval.request({
        agent,
        toolName: 'dsh_restart',
        callId,
        reason: approvalReason({
          policy: decision.policy,
          currentMode: decision.currentMode,
          escalationRequired: decision.escalationRequired,
          reason: cleanReason,
          activeSessions: preliminary.activeSessions,
          runningJobs: preliminary.runningJobs,
          reminders: preliminary.reminders,
        }),
        signal,
      })
      if (outcome !== 'allowed-once') {
        return errorResult(outcome === 'rejected' ? 'approval-rejected' : 'needs-approval', `Restart approval outcome: ${outcome}.`, { permission: decision })
      }
    }

    if (signal?.aborted === true) return errorResult('cancelled', 'The call was cancelled while waiting for approval.')

    // Re-snapshot after approval: the approval dialog can stay open for a while.
    const snap = await this.snapshot(agent, resumeOthers)
    const launch = detectLaunch({
      config: live(this.config.launch, {}),
      execPath: process.execPath,
      argv: process.argv,
      ppid: process.ppid,
      versions: process.versions,
      send: process.send,
      cwd: process.cwd(),
    })
    if (launch.ok === false) {
      return errorResult(launch.code ?? 'unsupported-launch', launch.message ?? 'Cannot determine how to relaunch DSH.')
    }

    const restartId = journal.makeRestartId()
    const dir = journal.restartDir(this.root, restartId)
    const now = Date.now()
    const callerPrompt = live(this.config.callerResumePrompt, defaultPromptFor('caller'))
    const otherPrompt = live(this.config.otherResumePrompt, defaultPromptFor('other'))
    const request = {
      version: journal.REQUEST_VERSION,
      restartId,
      createdAt: now,
      expiresAt: now + live(this.config.expiryMs, DEFAULT_EXPIRY_MS),
      profileKey: process.cwd(),
      hostPid: process.pid,
      desktopPid: launch.desktopPid,
      mode: launch.mode,
      reason: cleanReason,
      callers: snap.callers.map((row) => ({ ...row, callId: this.pendingCallId })),
      others: snap.others,
      resumeOthers: snap.resumeOthers,
      activeSessions: snap.activeSessions,
      runningJobs: snap.runningJobs,
      reminders: snap.reminders,
      permission: decision,
      promptSnapshot: {
        caller: promptHash(callerPrompt),
        other: promptHash(otherPrompt),
      },
      goTimeoutMs: live(this.config.goTimeoutMs, DEFAULT_GO_TIMEOUT_MS),
      shutdownGraceMs: live(this.config.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS),
      windowCheckMs: live(this.config.windowCheckMs, 4_000),
      windowCheckWaitMs: live(this.config.windowCheckWaitMs, 7_000),
      relaunchDelayMs: live(this.config.relaunchDelayMs, DEFAULT_RELAUNCH_DELAY_MS),
      relaunchWaitMs: live(this.config.relaunchWaitMs, DEFAULT_RELAUNCH_WAIT_MS),
      launch,
      marker: journal.marker(restartId),
    }

    const lock = journal.acquireLock(this.root, {
      pid: process.pid,
      restartId,
      createdAt: now,
    })
    if (!lock.acquired) {
      if (lock.current?.restartId !== undefined) {
        const pendingDir = journal.restartDir(this.root, lock.current.restartId)
        const pending = journal.readRequest(pendingDir)
        if (pending !== undefined) {
          const loaded = this.loadActive({ dir: pendingDir, request: pending })
          if (loaded.phase === 'go') {
            return errorResult('restart-in-progress', 'A DSH restart is already in progress.', { restartId: pending.restartId })
          }
          this.addCaller(loaded, agent, callId)
          return {
            ok: true,
            scheduled: true,
            alreadyPending: true,
            restartId: pending.restartId,
            sessions: pending.callers.length + pending.others.length,
            permission: pending.permission,
            message: 'Another restart is already pending; this session was added to the resume list.',
          }
        }
      }
      return errorResult('lock-held', 'Another restart request owns the restart lock.')
    }

    let helperPid
    try {
      journal.createRequest(this.root, request)
      const helper = spawnHelper({
        helperPath: HELPER_PATH,
        journalDir: dir,
        launch,
        env: process.env,
      })
      helperPid = helper.pid
      const ack = await waitForAck(dir, 10_000)
      if (ack.aborted === true) throw new Error('helper aborted before acknowledgement')
      if (ack.timedOut === true || ack.ack === undefined) throw new Error('helper did not acknowledge within 10s')
      request.helperPid = ack.ack.helperPid ?? helperPid
      request.helperStartedAt = ack.ack.startedAt
      journal.atomicWriteJson(journal.requestPath(dir), request)
    } catch (error) {
      try {
        journal.writeMarker(dir, 'abort', { reason: String(error?.message ?? error) })
      } catch {
        // The directory may not exist.
      }
      try {
        if (helperPid !== undefined && journal.isPidAlive(helperPid)) process.kill(helperPid, 'SIGKILL')
      } catch {
        // Best-effort cleanup.
      }
      journal.releaseLock(this.root, restartId)
      return errorResult('helper-unavailable', `Could not start the restart helper: ${String(error?.message ?? error)}`)
    }

    const activeState = this.loadActive({ dir, request })
    activeState.phase = 'requested'
    this.active = activeState
    this.pendingCalls.set(this.pendingCallId, { restartId, dir, sessionId: agent.id })
    this.armNoResultTimer(restartId, dir)

    return {
      ok: true,
      scheduled: true,
      restartId,
      sessions: snap.activeSessions,
      callerSessionId: agent.id,
      others: snap.others.map((row) => row.sessionId),
      permission: decision,
      message: `Restart scheduled (${restartId}). ${snap.activeSessions} active session(s) will be interrupted; the app will close and relaunch.`,
    }
  }

  loadActive(entry) {
    if (this.active !== null && this.active.request.restartId === entry.request.restartId) return this.active
    const active = {
      dir: entry.dir,
      request: entry.request,
      phase: journal.hasMarker(entry.dir, 'go') || journal.hasMarker(entry.dir, 'killing') ? 'go' : 'requested',
      quiescing: false,
    }
    for (const caller of entry.request.callers ?? []) {
      if (typeof caller.callId === 'string') {
        this.pendingCalls.set(caller.callId, { restartId: entry.request.restartId, dir: entry.dir, sessionId: caller.sessionId })
      }
    }
    return active
  }

  addCaller(active, agent, callId) {
    const record = { ...callerRecord(agent, callId), callId: callId ?? this.pendingCallId }
    const exists = active.request.callers.some((row) => row.sessionId === agent.id)
    if (!exists) {
      active.request.callers.push(record)
      active.request.activeSessions = (active.request.activeSessions ?? 0) + 1
      journal.updateRequest(active.dir, (request) => {
        request.callers = active.request.callers
        request.activeSessions = request.callers.length + (request.others?.length ?? 0)
        return request
      })
    }
    if (typeof record.callId === 'string') {
      this.pendingCalls.set(record.callId, { restartId: active.request.restartId, dir: active.dir, sessionId: agent.id })
    }
  }

  armNoResultTimer(restartId, dir) {
    clearTimeout(this.noResultTimer)
    const timeout = live(this.config.goTimeoutMs, DEFAULT_GO_TIMEOUT_MS)
    this.noResultTimer = setTimeout(() => {
      if (this.active?.request.restartId !== restartId || this.active.phase !== 'requested') return
      try {
        journal.writeMarker(dir, 'abort', { reason: 'caller-tool-result-not-observed' })
        journal.releaseLock(this.root, restartId)
      } catch {
        // Best effort.
      }
      this.active = null
      this.logger.warn(`restart ${restartId}: caller tool result was not observed; abort marker written`)
    }, timeout)
    this.noResultTimer.unref?.()
  }

  onSessionEvent(session, event) {
    if (this.active === null || this.active.phase !== 'requested') return
    if (event?.type !== 'tool/result') return
    const callId = event?.data?.message?.source?.callId
    if (typeof callId !== 'string') return
    const pending = this.pendingCalls.get(callId)
    if (pending === undefined) return
    if (pending.restartId !== this.active.request.restartId) return
    if (session?.id !== undefined && pending.sessionId !== undefined && session.id !== pending.sessionId) return
    this.pendingCalls.delete(callId)
    this.afterCallerResult(pending.restartId, pending.dir).catch((error) => {
      this.logger.error(`afterCallerResult failed: ${String(error?.stack ?? error)}`)
    })
  }

  async afterCallerResult(restartId, dir) {
    if (this.active === null || this.active.request.restartId !== restartId || this.active.quiescing) return
    this.active.quiescing = true
    this.active.phase = 'quiescing'
    this.draining = true
    clearTimeout(this.noResultTimer)
    this.noResultTimer = undefined

    try {
      await sleep(250)
      const agents = this.runtime().get('agents')?.list?.() ?? []
      for (const agent of agents) {
        try {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
        } catch {
          // An agent may dispose while we iterate.
        }
      }
      const grace = live(this.config.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS)
      await Promise.all(agents.map((agent) => settleWithin(agent.whenIdle(), grace, `idle:${agent.id}`)))

      const jobs = this.runtime().get('jobs')
      if (jobs !== undefined && typeof jobs.kill === 'function') {
        for (const agent of agents) {
          let owned = []
          try {
            owned = jobs.list(agent.id).filter((job) => job.status === 'running' || job.status === 'stopping')
          } catch {
            owned = []
          }
          for (const job of owned) {
            try {
              jobs.kill(job.id, agent.id, 'dsh restart')
            } catch {
              // Job may have settled.
            }
          }
        }
      }

      const persistence = this.runtime().get('sessionPersistence')
      if (persistence !== undefined && typeof persistence.flush === 'function') {
        await settleWithin(persistence.flush(), grace, 'persistence-flush')
      }
      const sessions = this.runtime().get('sessions')
      if (sessions !== undefined && typeof sessions.flush === 'function') {
        for (const session of sessions.list?.() ?? []) {
          await settleWithin(sessions.flush(session), grace, `session-flush:${session.id}`)
        }
      }

      if (!journal.isPidAlive(this.active.request.helperPid)) {
        journal.writeMarker(dir, 'abort', { reason: 'helper-died-before-go' })
        journal.releaseLock(this.root, restartId)
        this.draining = false
        this.active = null
        await this.notifyCancelled(restartId, dir)
        return
      }

      journal.writeMarker(dir, 'go', {
        helperPid: this.active.request.helperPid,
        sessions: agents.length,
      })
      this.active.phase = 'go'
      this.armKillWatchdog(restartId, dir)
    } catch (error) {
      try {
        journal.writeMarker(dir, 'abort', { reason: String(error?.message ?? error) })
        journal.releaseLock(this.root, restartId)
      } catch {
        // Best effort.
      }
      this.logger.error(`quiesce failed: ${String(error?.stack ?? error)}`)
      this.draining = false
      this.active = null
    }
  }

  armKillWatchdog(restartId, dir) {
    clearTimeout(this.watchdogTimer)
    this.watchdogTimer = setTimeout(() => {
      if (this.disposed || this.active?.request.restartId !== restartId) return
      if (journal.hasMarker(dir, 'killing') || journal.hasMarker(dir, 'relaunched')) return
      const helperPid = this.active.request.helperPid
      if (journal.isPidAlive(helperPid)) return
      try {
        journal.writeMarker(dir, 'abort', { reason: 'helper-died-after-go' })
        journal.releaseLock(this.root, restartId)
      } catch {
        // Best effort.
      }
      this.draining = false
      this.active = null
      this.notifyCancelled(restartId, dir).catch(() => {})
    }, 10_000)
    this.watchdogTimer.unref?.()
  }

  async notifyCancelled(restartId, dir) {
    const controller = this.runtime().get('sessionController')
    const caller = journal.readRequest(dir)?.callers?.[0]
    if (controller === undefined || typeof controller.prompt !== 'function' || caller === undefined) return
    const text = composePrompt({
      side: 'caller',
      template: 'The DSH restart was cancelled because the restart helper exited before it could stop the host. DSH is still running. Continue what you were doing; retry dsh_restart only if the user asks.',
      restartId,
      reason: 'helper exited before shutdown',
      time: new Date().toISOString(),
    })
    try {
      await controller.prompt({
        requestId: promptRequestId(restartId, caller.sessionId) + ':cancelled',
        sessionId: caller.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(15_000))
    } catch (error) {
      this.logger.warn(`could not notify caller about cancellation: ${String(error?.message ?? error)}`)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.draining = false
    clearTimeout(this.noResultTimer)
    clearTimeout(this.watchdogTimer)
    this.noResultTimer = undefined
    this.watchdogTimer = undefined
    // Do not delete the journal or release the lock here: a helper may still
    // be waiting for go while the host shuts down for the restart.
  }
}
