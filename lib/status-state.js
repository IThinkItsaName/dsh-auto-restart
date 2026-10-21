/**
 * Shared host-side state for the browser half.
 *
 * `draftHints` describes, for the sessions resumed by the last restart, the
 * last human message stored in each session. The browser half polls the
 * read-only status route to clear a draft that the killed renderer restored
 * from stale localStorage.
 */
export function createStatusState(now = Date.now) {
  let draftHints = { at: 0, sessions: [] }

  return {
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
      return { draftHints }
    },
  }
}
