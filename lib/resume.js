import * as journal from './journal.js'
import { composePrompt, defaultPromptFor, promptHash, promptRequestId } from './messages.js'
import { noticeMessageInput } from './notice.js'

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

function transient(error) {
  const text = String(error?.message ?? error ?? '')
  return /writer-held|agent-busy|gateway\/internal|timed? ?out|ECONNRESET|EPIPE/iu.test(text)
}

async function readEvents(ctx, sessionId) {
  const liveSession = ctx.sessions?.get?.(sessionId)
  if (liveSession !== undefined && typeof liveSession.snapshotEvents === 'function') {
    return liveSession.snapshotEvents()
  }
  const query = ctx.get('sessionQuery')
  if (query?.readSession !== undefined) {
    const snapshot = await query.readSession(sessionId)
    return snapshot?.events ?? []
  }
  return []
}

/**
 * Last human-authored message text of a session.
 *
 * Injected context (notices, compact checkpoints, approvals) carries a
 * non-`user` source and is skipped. The browser half compares a persisted
 * draft against this text to recognise a stale restore after the restart.
 */
async function lastHumanText(ctx, sessionId) {
  try {
    const events = await readEvents(ctx, sessionId)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const source = event.data?.source
      if (source !== undefined && source?.kind !== 'user') continue
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      const text = content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('')
      if (text !== '') return text
    }
  } catch {
    // Hints are best-effort: a read failure only skips the browser cleanup.
  }
  return ''
}

async function alreadyPrompted(ctx, sessionId, restartId, requestId) {
  const markerText = journal.marker(restartId)
  try {
    const events = await readEvents(ctx, sessionId)
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      const message = event.data
      if (message?.source?.rpcId === requestId) return true
      if (message?.source?.kind === 'dsh-auto-restart' && String(message?.source?.summary ?? '').includes(restartId)) return true
      const content = Array.isArray(message?.content) ? message.content : []
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.includes(markerText)) return true
      }
    }
  } catch {
    // A dedup read failure must not block the resume; the marker still guards
    // the common case and a duplicate prompt is less harmful than losing the
    // whole continuation.
  }
  return false
}

let llmModule
async function loadCreateUserMessage() {
  if (llmModule === undefined) {
    try {
      llmModule = await import('@deepseek-ai/dsh-llm')
    } catch {
      llmModule = null
    }
  }
  return llmModule?.createUserMessage
}

/**
 * Deliver the resume text as an injected notice instead of a user prompt.
 *
 * Returns 'unsupported' when the host exposes neither `resolveAgent` nor the
 * message factory; the caller then keeps the 0.1.x `prompt()` path, so a host
 * without these APIs loses the presentation, not the resume.
 */
export async function deliverResume(ctx, { sessionId, text, restartId }) {
  const controller = ctx.sessionController
  if (controller === null || typeof controller !== 'object' || typeof controller.resolveAgent !== 'function') {
    return 'unsupported'
  }
  const createUserMessage = await loadCreateUserMessage()
  if (typeof createUserMessage !== 'function') return 'unsupported'
  const resolved = await controller.resolveAgent(sessionId)
  if (resolved?.error !== undefined) throw resolved.error
  const agent = resolved?.agent
  if (agent === undefined) return 'unsupported'
  if (agent.status === 'running') return 'running'
  agent.followup(createUserMessage(noticeMessageInput({ text, restartId })))
  return 'notice'
}

async function promptOne(ctx, config, { sessionId, side, restartId, reason, dir, logger, windowCheck }) {
  const template = side === 'caller'
    ? live(config.callerResumePrompt, defaultPromptFor('caller'))
    : live(config.otherResumePrompt, defaultPromptFor('other'))
  const time = new Date().toISOString()
  let text = composePrompt({ side, template, restartId, reason, time })
  if (side === 'caller' && windowCheck?.visible === false) {
    text += '\n\n[Note: the restart helper did not observe a visible DSH desktop window after relaunch. If the window is still missing, start DSH manually.]'
  }
  const requestId = promptRequestId(restartId, sessionId)

  if (await alreadyPrompted(ctx, sessionId, restartId, requestId)) {
    journal.appendResult(dir, { sessionId, side, at: time, status: 'already' })
    return 'already'
  }
  if (ctx.agents?.get?.(sessionId)?.status === 'running') {
    journal.appendResult(dir, { sessionId, side, at: time, status: 'skipped-active' })
    return 'skipped-active'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('resume prompt timed out')), 30_000)
  let lastError
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const delivery = await deliverResume(ctx, { sessionId, text, restartId })
        if (delivery === 'running') {
          journal.appendResult(dir, { sessionId, side, at: time, status: 'skipped-active' })
          return 'skipped-active'
        }
        if (delivery === 'unsupported') {
          await ctx.sessionController.prompt({
            requestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          }, controller.signal)
        }
        journal.appendResult(dir, {
          sessionId,
          side,
          at: time,
          status: 'prompted',
          delivery: delivery === 'notice' ? 'notice' : 'prompt',
          promptHash: promptHash(text),
          requestId,
        })
        return 'prompted'
      } catch (error) {
        lastError = error
        if (!transient(error) || attempt === 2) break
        await sleep(attempt === 0 ? 1_000 : 3_000)
      }
    }
  } finally {
    clearTimeout(timer)
  }
  const message = String(lastError?.message ?? lastError ?? 'unknown')
  journal.appendResult(dir, { sessionId, side, at: time, status: 'failed', error: message, requestId })
  logger?.warn?.(`resume ${sessionId} (${side}) failed: ${message}`)
  return 'failed'
}

async function runLimited(items, limit, worker) {
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

/**
 * Process one journal on a freshly started host.
 *
 * Callers are prompted first, then other active sessions. Every prompt is
 * idempotent: a marker or the deterministic request id in the session log
 * suppresses a duplicate after a crash between prompt and result write.
 */
export async function resumeJournal({ ctx, config, dir, request: suppliedRequest, logger, root }) {
  const request = suppliedRequest ?? journal.readRequest(dir)
  if (!request) return { skipped: 'missing-request' }
  if (Date.now() > Number(request.expiresAt ?? 0)) {
    journal.writeCompleted(dir, { status: 'expired', at: new Date().toISOString() })
    return { skipped: 'expired' }
  }
  if (!journal.hasMarker(dir, 'go') && !journal.hasMarker(dir, 'killing') && !journal.hasMarker(dir, 'relaunched')) {
    return { skipped: 'not-released' }
  }
  if (!journal.claimJournal(dir, { pid: process.pid, at: new Date().toISOString(), restartId: request.restartId })) {
    return { skipped: 'claimed' }
  }

  const webUrl = ctx.get('webServer')?.getOrigin?.()
  journal.writeMarker(dir, 'host-ready', {
    newHostPid: process.pid,
    webUrl,
    restartId: request.restartId,
  })

  // The helper writes window-check after it has had time to observe the new
  // desktop process. Wait for it before composing the caller notice, but never
  // block resume forever if the helper is an older build.
  const windowCheckWaitMs = Math.max(0, Number(live(config.windowCheckWaitMs, 7_000)) || 0)
  if (windowCheckWaitMs > 0 && journal.hasMarker(dir, 'relaunched')) {
    const deadline = Date.now() + windowCheckWaitMs
    while (!journal.hasMarker(dir, 'window-check') && Date.now() < deadline) {
      await sleep(150)
    }
  }
  const windowCheck = journal.readMarker(dir, 'window-check')

  const startupDelayMs = live(config.startupDelayMs, 3_000)
  if (startupDelayMs > 0) await sleep(startupDelayMs)

  if (ctx.get('sessionController')?.prompt === undefined) {
    journal.writeMarker(dir, 'resume-error', { reason: 'sessionController-unavailable', at: new Date().toISOString() })
    logger?.warn?.('resume skipped: sessionController is unavailable')
    return { skipped: 'no-session-controller' }
  }

  const callers = live(config.resumeCallers, true) === false ? [] : (Array.isArray(request.callers) ? request.callers : [])
  const others = request.resumeOthers === false ? [] : (Array.isArray(request.others) ? request.others : [])
  const max = Number(live(config.maxResumeSessions, 0)) || 0
  const records = []
  const seen = new Set()
  for (const row of callers) {
    if (row?.sessionId && !seen.has(row.sessionId)) {
      seen.add(row.sessionId)
      records.push({ ...row, side: 'caller' })
    }
  }
  for (const row of others) {
    if (records.length >= max && max > 0) break
    if (row?.sessionId && !seen.has(row.sessionId)) {
      seen.add(row.sessionId)
      records.push({ ...row, side: 'other' })
    }
  }

  const stagger = Math.max(0, Number(live(config.resumeStaggerMs, 1_500)) || 0)
  const concurrency = Math.max(1, Number(live(config.maxResumeConcurrency, 2)) || 2)
  const results = []
  await runLimited(records, concurrency, async (record) => {
    const status = await promptOne(ctx, config, {
      sessionId: record.sessionId,
      side: record.side,
      restartId: request.restartId,
      reason: request.reason,
      dir,
      logger,
      windowCheck,
    })
    results.push({ sessionId: record.sessionId, side: record.side, status })
    if (stagger > 0) await sleep(stagger)
  })

  const draftHints = []
  for (const row of results) {
    if (row.status === 'failed') continue
    const lastUserText = await lastHumanText(ctx, row.sessionId)
    if (lastUserText !== '') draftHints.push({ sessionId: row.sessionId, lastUserText })
  }

  journal.writeCompleted(dir, {
    status: 'completed',
    at: new Date().toISOString(),
    results,
    draftHints,
  })
  journal.writeState(root, {
    lastCompletedAt: Date.now(),
    lastRestartId: request.restartId,
  })
  logger?.info?.(`restart ${request.restartId}: resumed ${results.filter((row) => row.status === 'prompted').length}/${records.length} session(s)`)
  return { completed: true, results, draftHints }
}
