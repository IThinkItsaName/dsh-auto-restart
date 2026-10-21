#!/usr/bin/env node
/**
 * Detached restart helper.
 *
 * Lifecycle:
 *   start -> ack -> wait go -> kill -> relaunch -> wait host-ready -> exit
 *
 * The helper never kills anything until the coordinator has settled sessions
 * and written go.json. If go never arrives, it exits without killing DSH.
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync as appendFs, closeSync as closeFs, existsSync as existsFs, openSync as openFs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPidAlive, readJson, hasMarker, sleep, writeMarker } from './journal.js'

const DEFAULT_GO_TIMEOUT_MS = 30_000
const DEFAULT_DESKTOP_WAIT_MS = 10_000
const DEFAULT_EXIT_WAIT_MS = 15_000
const DEFAULT_RELAUNCH_DELAY_MS = 1_500
const DEFAULT_RELAUNCH_WAIT_MS = 60_000
const DEFAULT_WINDOW_CHECK_MS = 4_000
const DEFAULT_WINDOW_CHECK_WAIT_MS = 7_000
const DEFAULT_WINDOW_CHECK_TIMEOUT_MS = 2_000
const WINDOW_CHECK_INTERVAL_MS = 500

/**
 * `windowsHide` is correct for the hidden Node helper and CLI hosts, but it
 * hides the GUI window of the packaged Electron app. Keep the relaunch branch
 * explicit so this cannot regress silently.
 */
export function relaunchWindowsHide(mode) {
  return mode !== 'desktop'
}

/** Parse `state|title` emitted by the PowerShell window probe. */
export function parseWindowCheckOutput(text) {
  const line = String(text ?? '').trim()
  const partition = line.indexOf('|')
  const state = (partition < 0 ? line : line.slice(0, partition)).trim()
  const title = (partition < 0 ? '' : line.slice(partition + 1)).trim()
  return {
    state: state === '' ? 'unknown' : state,
    visible: state === 'visible' ? true : state === 'hidden' ? false : null,
    title: title === '' ? undefined : title,
  }
}

function powershellPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Build the PowerShell window probe.
 *
 * The `if` / `elseif` / `else` chain must stay ONE statement. Semicolons
 * between the branches (`}; elseif`) make PowerShell parse `elseif` as a new
 * command, exit 1, and the probe reports `probe-failed` on every run — the
 * 0.1.1 behaviour this shape replaces.
 */
export function buildWindowProbeScript(pid) {
  return [
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue;`,
    "if ($null -eq $p) { 'missing|' }",
    "elseif (-not [string]::IsNullOrWhiteSpace($p.MainWindowTitle)) { 'visible|' + $p.MainWindowTitle }",
    "elseif ($p.MainWindowHandle -ne 0) { 'unknown|' }",
    "else { 'hidden|' }",
  ].join(' ')
}

/**
 * Best-effort visible-window probe.
 *
 * One PowerShell round-trip answers "is the main window visible right now".
 * The relaunched Electron window can take several seconds to get its title, so
 * callers may give the probe a budget: `hidden`/`unknown` are retried until the
 * budget is spent or the window becomes visible. A failed probe is reported as
 * `probe-failed`, never as "hidden".
 */
export function windowCheckStatus(pid, timeoutMs = DEFAULT_WINDOW_CHECK_TIMEOUT_MS, waitMs = 0) {
  if (process.platform !== 'win32') return { state: 'non-windows', visible: null }
  const exe = powershellPath()
  if (!existsFs(exe)) return { state: 'powershell-missing', visible: null }
  const budget = Math.max(0, Number(waitMs) || 0)
  const deadline = Date.now() + budget
  let last = { state: 'unknown', visible: null }
  for (;;) {
    const result = probeWindowOnce(exe, pid, timeoutMs)
    if (result.state !== 'hidden' && result.state !== 'unknown') return result
    last = result
    const remaining = deadline - Date.now()
    if (remaining <= 0) return last
    sleepSync(Math.min(WINDOW_CHECK_INTERVAL_MS, remaining))
  }
}

/** One probe round-trip; see {@link windowCheckStatus}. */
function probeWindowOnce(exe, pid, timeoutMs) {
  const script = buildWindowProbeScript(pid)
  try {
    const output = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseWindowCheckOutput(output)
  } catch (error) {
    return { state: 'probe-failed', visible: null, error: String(error?.message ?? error) }
  }
}

/** Synchronous sleep for the polling loop (the helper runs on the main thread). */
function sleepSync(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 5_000))
}

function now() {
  return new Date().toISOString()
}

function makeLogger(dir) {
  return (message) => {
    try {
      appendFs(join(dir, 'helper.log'), `${now()} ${message}\n`, 'utf8')
    } catch {
      // Logging must never take the helper down.
    }
  }
}

function requestValue(request, key, fallback) {
  const value = request?.[key]
  return value === undefined || value === null ? fallback : value
}

async function waitForGo(dir, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasMarker(dir, 'abort')) return { kind: 'abort' }
    if (hasMarker(dir, 'go')) return { kind: 'go' }
    await sleep(150)
  }
  return { kind: 'timeout' }
}

async function waitGone(pid, timeoutMs) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await sleep(150)
  }
  return !isPidAlive(pid)
}

function killPid(pid, log) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: true }
  if (pid === process.pid) return { ok: false, reason: 'refusing to kill helper itself' }
  try {
    process.kill(pid, 'SIGKILL')
    log(`killed pid ${pid}`)
    return { ok: true }
  } catch (error) {
    if (error?.code === 'ESRCH') {
      log(`pid ${pid} already gone`)
      return { ok: true }
    }
    log(`kill pid ${pid} failed: ${error?.code ?? error?.message ?? error}`)
    return { ok: false, reason: String(error?.code ?? error?.message ?? error) }
  }
}

async function stopTargets(request, dir, log) {
  const mode = request?.launch?.mode === 'cli' ? 'cli' : 'desktop'
  const hostPid = request?.hostPid
  const desktopPid = request?.desktopPid
  if (mode === 'desktop' && Number.isSafeInteger(desktopPid) && desktopPid > 0) {
    // Killing the Electron main process closes the IPC channel; the host
    // observes disconnect and shuts itself down through application.shutdown.
    const first = killPid(desktopPid, log)
    if (!first.ok) return { ok: false, reason: `cannot terminate Electron main: ${first.reason}` }
    const hostGone = await waitGone(hostPid, requestValue(request, 'desktopWaitMs', DEFAULT_DESKTOP_WAIT_MS))
    if (!hostGone) {
      const second = killPid(hostPid, log)
      if (!second.ok) return { ok: false, reason: `cannot terminate host: ${second.reason}` }
    }
    if (isPidAlive(desktopPid)) {
      const third = killPid(desktopPid, log)
      if (!third.ok) return { ok: false, reason: `Electron main survived: ${third.reason}` }
    }
    const [hostStopped, desktopStopped] = await Promise.all([
      waitGone(hostPid, requestValue(request, 'exitWaitMs', DEFAULT_EXIT_WAIT_MS)),
      waitGone(desktopPid, requestValue(request, 'exitWaitMs', DEFAULT_EXIT_WAIT_MS)),
    ])
    if (!hostStopped || !desktopStopped) return { ok: false, reason: 'target processes did not exit' }
    return { ok: true }
  }

  const killed = killPid(hostPid, log)
  if (!killed.ok) return { ok: false, reason: `cannot terminate host: ${killed.reason}` }
  if (!await waitGone(hostPid, requestValue(request, 'exitWaitMs', DEFAULT_EXIT_WAIT_MS))) {
    return { ok: false, reason: 'host did not exit' }
  }
  return { ok: true }
}

function launchFreshApp(request, dir, log) {
  const launch = request?.launch
  if (!launch || typeof launch.executable !== 'string' || launch.executable === '') {
    return { ok: false, reason: 'launch executable is missing' }
  }
  const env = { ...process.env }
  // Critical: the host env is Node mode. The GUI app must not inherit it.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ASAR
  const args = Array.isArray(launch.args) ? launch.args : []
  const logPath = join(dir, 'relaunch.log')
  let fd
  try {
    fd = openFs(logPath, 'a')
    const child = spawn(launch.executable, args, {
      cwd: typeof launch.cwd === 'string' && launch.cwd !== '' ? launch.cwd : dirname(launch.executable),
      env,
      detached: true,
      // The GUI app must create a visible window; the helper's own launch uses
      // windowsHide:true elsewhere. CLI mode may stay hidden.
      windowsHide: relaunchWindowsHide(launch.mode),
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    const pid = child.pid
    closeFs(fd)
    fd = undefined
    return { ok: true, pid }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeFs(fd)
      } catch {
        // Ignore close failure.
      }
    }
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

async function main() {
  const journalDirArg = process.argv[2]
  if (!journalDirArg) {
    throw new Error('usage: helper.mjs <journal-dir> [--dry-run]')
  }
  const dir = resolve(journalDirArg)
  const dryRun = process.argv.includes('--dry-run')
  const log = makeLogger(dir)
  log(`helper started pid=${process.pid} dryRun=${String(dryRun)} dir=${dir}`)

  const request = readJson(join(dir, 'request.json'))
  if (!request || typeof request.restartId !== 'string') throw new Error('request.json is missing or invalid')
  if (typeof request.expiresAt === 'number' && request.expiresAt <= Date.now()) {
    writeMarker(dir, 'aborted', { reason: 'expired-before-start' })
    log('request already expired')
    return
  }

  writeMarker(dir, 'ack', {
    helperPid: process.pid,
    startedAt: now(),
    mode: request?.launch?.mode === 'cli' ? 'cli' : 'desktop',
    targets: { hostPid: request.hostPid, desktopPid: request.desktopPid },
    dryRun,
  })
  log('ack written')

  if (dryRun) {
    writeMarker(dir, 'dry-run', { helperPid: process.pid })
    log('dry-run complete; no process was touched')
    return
  }

  const go = await waitForGo(dir, requestValue(request, 'goTimeoutMs', DEFAULT_GO_TIMEOUT_MS), log)
  if (go.kind !== 'go') {
    writeMarker(dir, 'aborted', { reason: go.kind === 'abort' ? 'coordinator-abort' : 'go-timeout' })
    log(`not killing: ${go.kind}`)
    return
  }

  // Re-check the lease immediately before the destructive action.
  const fresh = readJson(join(dir, 'request.json'))
  if (!fresh || fresh.restartId !== request.restartId) {
    writeMarker(dir, 'aborted', { reason: 'lease-mismatch' })
    log('lease mismatch; not killing')
    return
  }
  if (typeof fresh.expiresAt === 'number' && fresh.expiresAt <= Date.now()) {
    writeMarker(dir, 'aborted', { reason: 'expired-before-kill' })
    log('request expired before kill; not killing')
    return
  }
  if (hasMarker(dir, 'abort')) {
    writeMarker(dir, 'aborted', { reason: 'coordinator-abort-before-kill' })
    log('abort marker won the race; not killing')
    return
  }

  writeMarker(dir, 'killing', {
    helperPid: process.pid,
    targets: { hostPid: fresh.hostPid, desktopPid: fresh.desktopPid },
    mode: fresh?.launch?.mode === 'cli' ? 'cli' : 'desktop',
  })
  log('killing targets')

  const stopped = await stopTargets(fresh, dir, log)
  if (!stopped.ok) {
    writeMarker(dir, 'failed', { reason: stopped.reason, phase: 'stop-targets' })
    log(`stop targets failed: ${stopped.reason}`)
    return
  }
  log('targets stopped')

  await sleep(requestValue(fresh, 'relaunchDelayMs', DEFAULT_RELAUNCH_DELAY_MS))

  const launched = launchFreshApp(fresh, dir, log)
  if (!launched.ok) {
    writeMarker(dir, 'failed', { reason: launched.reason, phase: 'launch' })
    log(`launch failed: ${launched.reason}`)
    return
  }
  writeMarker(dir, 'relaunched', { newPid: launched.pid, at: now() })
  log(`relaunched pid=${launched.pid}`)

  if (fresh?.launch?.mode === 'desktop') {
    const windowCheckMs = requestValue(fresh, 'windowCheckMs', DEFAULT_WINDOW_CHECK_MS)
    if (windowCheckMs > 0) {
      await sleep(windowCheckMs)
      const windowWaitMs = requestValue(fresh, 'windowCheckWaitMs', DEFAULT_WINDOW_CHECK_WAIT_MS)
      const pollMs = Math.max(0, Number(windowWaitMs) - Number(windowCheckMs))
      const check = windowCheckStatus(launched.pid, undefined, pollMs)
      writeMarker(dir, 'window-check', {
        newPid: launched.pid,
        ...check,
        at: now(),
      })
      log(`window-check state=${check.state}${check.title === undefined ? '' : ` title=${check.title}`}`)
      if (check.visible === false) log('WARNING: relaunched desktop process has no visible main window')
    }
  } else {
    writeMarker(dir, 'window-check', { state: 'cli', visible: null, at: now() })
  }

  const deadline = Date.now() + requestValue(fresh, 'relaunchWaitMs', DEFAULT_RELAUNCH_WAIT_MS)
  while (Date.now() < deadline) {
    if (existsFs(join(dir, 'host-ready.json'))) {
      log('new host reported ready')
      return
    }
    if (!isPidAlive(launched.pid)) {
      writeMarker(dir, 'failed', { reason: 'relaunched process exited before host-ready', phase: 'relaunch' })
      log('new process exited before host-ready')
      return
    }
    await sleep(250)
  }
  writeMarker(dir, 'failed', { reason: 'host-ready timeout', phase: 'host-ready' })
  log('host-ready timeout')
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main().catch((error) => {
    const dirArg = process.argv[2]
    try {
      if (dirArg) {
        const dir = resolve(dirArg)
        appendFs(join(dir, 'helper.log'), `${now()} fatal: ${String(error?.stack ?? error)}\n`, 'utf8')
        writeMarker(dir, 'failed', { reason: String(error?.message ?? error), phase: 'fatal' })
      }
    } catch {
      // Nothing else can be done.
    }
    console.error(error)
    process.exitCode = 1
  })
}
