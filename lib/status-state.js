/**
 * Shared host-side state for the browser half.
 *
 * `reloadAt` is a pending "refresh the web UI" request: the page polls
 * `/plugins/dsh-auto-restart/status.json` and reloads itself when it sees a
 * request newer than its own start time. The host is not restarted.
 *
 * `page` is the last browser heartbeat: the client sends a per-page boot id on
 * every poll, so the tool can confirm that a NEW page instance came back after
 * the reload instead of only claiming that a request was written.
 *
 * `draftHints` describes, for the sessions resumed by the last restart, the
 * last human message stored in each session. The browser half uses it to clear
 * a draft that the killed renderer restored from stale localStorage.
 */
export function createStatusState(now = Date.now) {
  let reloadAt = 0
  let reloadToken = ''
  let draftHints = { at: 0, sessions: [] }
  let page = { bootId: '', at: 0, polls: 0 }
  let reloadGate = () => false

  return {
    /** Settings gate: `dsh_reload` is refused while this returns false. */
    setReloadGate(gate) {
      reloadGate = typeof gate === 'function' ? gate : () => false
    },
    reloadEnabled() {
      try {
        return reloadGate() === true
      } catch {
        return false
      }
    },
    requestReload() {
      reloadAt = now()
      reloadToken = `${reloadAt}-${Math.random().toString(36).slice(2, 10)}`
      return { reloadAt, reloadToken }
    },
    /** Record one browser heartbeat; a changed boot id means a new page. */
    notePoll(bootId) {
      const id = typeof bootId === 'string' ? bootId.slice(0, 80) : ''
      if (id === '') return
      page = { bootId: id, at: now(), polls: page.bootId === id ? page.polls + 1 : 1 }
    },
    setDraftHints(sessions) {
      const rows = Array.isArray(sessions) ? sessions : []
      draftHints = {
        at: now(),
        sessions: rows
          .filter((row) => row !== null && typeof row === 'object' && typeof row.sessionId === 'string' && row.sessionId !== '')
          .slice(0, 32)
          .map((row) => ({
            sessionId: row.sessionId,
            lastUserText: typeof row.lastUserText === 'string' ? row.lastUserText : '',
          })),
      }
    },
    snapshot() {
      return { reloadAt, reloadToken, draftHints, page }
    },
  }
}
