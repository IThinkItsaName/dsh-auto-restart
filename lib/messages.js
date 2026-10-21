import { createHash } from 'node:crypto'
import { marker } from './journal.js'

/** Default caller continuation body. The marker is prepended by composePrompt. */
export const DEFAULT_CALLER_PROMPT = `DSH has restarted. The previous turn was interrupted by the restart you requested, and this session has been reloaded.
Reason: {{reason}}
The restart tool call completed before shutdown. Continue the work you were doing before the restart. Verify that the plugin/config change you requested is actually loaded before relying on it. Do not call dsh_restart again unless the user explicitly asks.`

/** Default other-session continuation body. Never contains the caller's reason. */
export const DEFAULT_OTHER_PROMPT = `The DSH host restarted because another session requested it. Your active turn was interrupted.
Your session log was recovered; any tool call without a durable result now has a synthetic interrupted result. Inspect external state before retrying side-effecting operations, and continue the task that was running. If you were waiting for the user, ask again rather than assuming approval. Do not call dsh_restart yourself unless the user explicitly asks.`

export const MAX_PROMPT_CHARS = 4000
export const MAX_REASON_CHARS = 500

export function defaultPromptFor(side) {
  return side === 'caller' ? DEFAULT_CALLER_PROMPT : DEFAULT_OTHER_PROMPT
}

/** Stable per-session request identity; also recorded in the user message source. */
export function promptRequestId(restartId, sessionId) {
  return `dsh-auto-restart:${restartId}:${sessionId}`
}

export function promptHash(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)
}

/**
 * Compose the user-role continuation message.
 *
 * The marker is always prepended, even if the editable template does not carry
 * it. Idempotency therefore survives prompt customization.
 */
export function composePrompt({ side, template, restartId, reason, time } = {}) {
  const fallback = defaultPromptFor(side)
  const source = typeof template === 'string' && template.trim() !== '' ? template.trim() : fallback
  const markerText = marker(restartId)
  const withoutMarker = source.startsWith(markerText) ? source.slice(markerText.length).trimStart() : source
  const reasonText = side === 'caller'
    ? (typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : 'unspecified')
    : 'another session requested it'
  const body = withoutMarker
    .replaceAll('{{restartId}}', String(restartId ?? ''))
    .replaceAll('{{time}}', String(time ?? ''))
    .replaceAll('{{reason}}', reasonText)
    .slice(0, MAX_PROMPT_CHARS)
  return `${markerText} ${body}`
}

export function callerPrompt(template, { restartId, reason, time } = {}) {
  return composePrompt({ side: 'caller', template, restartId, reason, time })
}

export function otherPrompt(template, { restartId, time } = {}) {
  return composePrompt({ side: 'other', template, restartId, time })
}
