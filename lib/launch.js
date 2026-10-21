/**
 * Launch-spec resolution and helper spawning.
 *
 * Packaging facts this relies on (0.2.1 desktop host):
 *  - the host is a Node-mode child of the Electron main process;
 *  - `process.execPath` is the Electron executable;
 *  - the host env carries ELECTRON_RUN_AS_NODE=1;
 *  - the host is spawned with an IPC channel.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { sleep } from './journal.js'

export function isPackagedDesktopExecutable(execPath) {
  if (typeof execPath !== 'string' || execPath === '') return false
  const name = basename(execPath).toLowerCase()
  const parent = basename(dirname(execPath)).toLowerCase()
  return name.includes('deepseek harness') || parent === 'dsh_desktop'
}

function normalizeArgs(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('launch.args must be an array of strings')
  }
  return [...value]
}

export function sanitizeRelaunchEnv(env = process.env) {
  const next = { ...env }
  // The host runs as Node; the GUI app must not inherit Node mode.
  delete next.ELECTRON_RUN_AS_NODE
  delete next.ELECTRON_NO_ASAR
  return next
}

/**
 * Resolve the command that starts a fresh desktop/CLI host.
 *
 * Auto-detection intentionally supports the packaged desktop app and plain
 * node CLI only. A dev Electron launch must provide an explicit `launch`
 * override; guessing there would start the wrong application.
 */
export function detectLaunch({
  config = {},
  execPath = process.execPath,
  argv = process.argv,
  ppid = process.ppid,
  versions = process.versions,
  send = process.send,
  cwd = process.cwd(),
} = {}) {
  const configured = config && typeof config === 'object' ? config : {}
  if (typeof configured.executable === 'string' && configured.executable.trim() !== '') {
    return {
      ok: true,
      mode: configured.mode === 'cli' ? 'cli' : 'desktop',
      executable: configured.executable,
      args: normalizeArgs(configured.args),
      cwd: typeof configured.cwd === 'string' && configured.cwd !== '' ? configured.cwd : dirname(configured.executable),
      hostPid: process.pid,
      desktopPid: configured.mode === 'cli' ? undefined : ppid,
      source: 'config',
    }
  }

  const electron = typeof versions?.electron === 'string' && versions.electron !== ''
  const hasIpc = typeof send === 'function'
  if (electron && hasIpc) {
    if (!isPackagedDesktopExecutable(execPath)) {
      return {
        ok: false,
        code: 'unsupported-launch',
        message: 'This Electron host is not the packaged DeepSeek Harness app. Set config.launch {mode, executable, args, cwd} explicitly.',
      }
    }
    return {
      ok: true,
      mode: 'desktop',
      executable: execPath,
      args: [],
      cwd: dirname(execPath),
      hostPid: process.pid,
      desktopPid: ppid,
      source: 'auto-desktop',
    }
  }

  return {
    ok: true,
    mode: 'cli',
    executable: execPath,
    args: argv.slice(1),
    cwd,
    hostPid: process.pid,
    desktopPid: undefined,
    source: 'auto-cli',
  }
}

/**
 * Spawn the detached helper. The helper must not be in the host's stdio or
 * console lifetime, and must never be killed by a tree-kill of the host.
 */
export function spawnHelper({ helperPath, journalDir, launch, env = process.env } = {}) {
  const helperEnv = { ...env }
  if (launch.mode === 'desktop') helperEnv.ELECTRON_RUN_AS_NODE = '1'
  else delete helperEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(launch.executable, [helperPath, journalDir], {
    cwd: tmpdir(),
    env: helperEnv,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { pid: child.pid }
}

export async function waitForJson(file, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        // Writer is mid-rename or the file is incomplete; retry.
      }
    }
    await sleep(intervalMs)
  }
  return undefined
}

export async function waitForAck(dir, timeoutMs) {
  const ackPath = join(dir, 'ack.json')
  const abortPath = join(dir, 'abort.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(abortPath)) return { aborted: true }
    if (existsSync(ackPath)) {
      try {
        return { ack: JSON.parse(readFileSync(ackPath, 'utf8')) }
      } catch {
        // Retry a partially visible write.
      }
    }
    await sleep(150)
  }
  return { timedOut: true }
}

export function launchSummary(launch) {
  if (!launch || launch.ok === false) return launch?.message ?? 'launch unavailable'
  return `${launch.mode}: ${launch.executable}${launch.args.length === 0 ? '' : ` ${launch.args.join(' ')}`}`
}
