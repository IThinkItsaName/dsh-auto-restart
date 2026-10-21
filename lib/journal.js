/**
 * Cross-process restart journal.
 *
 * This module is deliberately dependency-free: the detached helper runs through
 * Electron-as-Node (or plain node) and must not import any DSH package.
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const MARKER_PREFIX = '[dsh-auto-restart:'
export const REQUEST_VERSION = 1

/** Marker embedded at the start of every resume prompt. */
export function marker(restartId) {
  return `${MARKER_PREFIX}${restartId}]`
}

export function isMarker(text, restartId) {
  return typeof text === 'string' && text.includes(marker(restartId))
}

/** Expand a user-supplied path (`~`, relative, absolute) without touching disk. */
export function expandPath(value, home = homedir()) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const raw = value.trim()
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(home, raw.slice(2))
  return isAbsolute(raw) ? raw : resolve(raw)
}

/** Resolve `$DSH_HOME`, matching the host's own precedence. */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') return expandPath(raw, home)
  return join(home, '.dsh')
}

/** Root journal directory; a configured absolute path wins. */
export function defaultRoot(configured, env = process.env, home = homedir()) {
  if (typeof configured === 'string' && configured.trim() !== '') return expandPath(configured, home)
  return join(resolveDshHome(env, home), 'dsh-auto-restart')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

function tempPath(file) {
  return `${file}.${process.pid}.${randomUUID()}.tmp`
}

/** Atomic JSON replacement. Windows rename replaces an existing file. */
export function atomicWriteJson(file, value) {
  ensureDir(dirname(file))
  const tmp = tempPath(file)
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (error) {
    // A few Windows/AV combinations reject replacement while the target exists.
    try {
      unlinkSync(file)
    } catch {
      // The target may have been removed concurrently.
    }
    renameSync(tmp, file)
  }
  return value
}

/** Create a JSON file exclusively; throws EEXIST when another process owns it. */
export function writeJsonIfAbsent(file, value) {
  ensureDir(dirname(file))
  const fd = openSync(file, 'wx')
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return value
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)))
}

/** Unique, sortable restart identity. */
export function makeRestartId(now = Date.now()) {
  return `restart-${now.toString(36)}-${randomUUID().slice(0, 8)}`
}

export function restartDir(root, restartId) {
  return join(root, restartId)
}

export function requestPath(dir) {
  return join(dir, 'request.json')
}

/** Try to take the single-flight lock; stale dead-PID locks are reclaimed. */
export function acquireLock(root, info) {
  ensureDir(root)
  const file = join(root, 'lock.json')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeJsonIfAbsent(file, info)
      return { acquired: true, file, current: info }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const current = readJson(file)
      if (current && isPidAlive(current.pid)) {
        return { acquired: false, file, current }
      }
      try {
        unlinkSync(file)
      } catch {
        // A concurrent cleanup already removed it.
      }
    }
  }
  return { acquired: false, file, current: readJson(file) }
}

export function releaseLock(root, restartId) {
  const file = join(root, 'lock.json')
  const current = readJson(file)
  if (current === undefined || current.restartId === restartId) {
    try {
      unlinkSync(file)
    } catch {
      // Already released.
    }
  }
}

export function createRequest(root, request) {
  const dir = restartDir(root, request.restartId)
  ensureDir(dir)
  atomicWriteJson(requestPath(dir), request)
  return dir
}

export function updateRequest(dir, mutate) {
  const current = readJson(requestPath(dir))
  if (current === undefined) throw new Error(`restart request is missing: ${dir}`)
  const next = mutate(structuredClone(current))
  atomicWriteJson(requestPath(dir), next)
  return next
}

export function readRequest(dir) {
  return readJson(requestPath(dir))
}

export function markerPath(dir, name) {
  return join(dir, `${name}.json`)
}

export function writeMarker(dir, name, value = {}) {
  return atomicWriteJson(markerPath(dir, name), {
    at: new Date().toISOString(),
    ...value,
  })
}

export function readMarker(dir, name) {
  return readJson(markerPath(dir, name))
}

export function hasMarker(dir, name) {
  return existsSync(markerPath(dir, name))
}

/** Claim a live journal for this host process. */
export function claimJournal(dir, info) {
  const file = join(dir, 'claimed.json')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeJsonIfAbsent(file, info)
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const current = readJson(file)
      if (current && isPidAlive(current.pid)) return current.pid === info.pid
      try {
        unlinkSync(file)
      } catch {
        // Another process removed a stale claim.
      }
    }
  }
  return false
}

/** Journals that represent a real restart (the helper was released or acted). */
export function findActive(root, now = Date.now()) {
  if (!existsSync(root)) return []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('restart-')) continue
    const dir = join(root, entry.name)
    if (hasMarker(dir, 'completed')) continue
    const request = readRequest(dir)
    if (!request || !Number.isFinite(request.expiresAt) || request.expiresAt <= now) continue
    if (!hasMarker(dir, 'go') && !hasMarker(dir, 'killing') && !hasMarker(dir, 'relaunched')) continue
    result.push({ dir, request })
  }
  return result.sort((a, b) => (b.request.createdAt ?? 0) - (a.request.createdAt ?? 0))
}

export function appendResult(dir, result) {
  ensureDir(dir)
  appendFileSync(join(dir, 'results.jsonl'), `${JSON.stringify(result)}\n`, 'utf8')
}

export function writeCompleted(dir, value) {
  return writeMarker(dir, 'completed', value)
}

export function writeState(root, value) {
  return atomicWriteJson(join(root, 'state.json'), value)
}

export function readState(root) {
  return readJson(join(root, 'state.json'), undefined)
}

/** Best-effort removal of old completed/expired journals. */
export function prune(root, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()) {
  if (!existsSync(root)) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('restart-')) continue
    const dir = join(root, entry.name)
    try {
      const request = readRequest(dir)
      const completedAt = readMarker(dir, 'completed')?.at
      const finished = hasMarker(dir, 'completed') || (request?.expiresAt !== undefined && request.expiresAt < now)
      if (!finished) continue
      const anchor = completedAt === undefined ? statSync(dir).mtimeMs : Date.parse(completedAt)
      if (Number.isFinite(anchor) && now - anchor > maxAgeMs) {
        // Recursive removal is intentionally not used: keep the directory and
        // drop only the files this plugin owns.
        for (const name of readdirSync(dir)) {
          try {
            unlinkSync(join(dir, name))
          } catch {
            // A file may still be open by the helper; the next prune retries.
          }
        }
        try {
          unlinkSync(dir)
        } catch {
          // Directory may still contain a file opened by another process.
        }
      }
    } catch {
      // A partially written journal must never break host startup.
    }
  }
}

export function basenameOf(path) {
  return basename(path)
}
