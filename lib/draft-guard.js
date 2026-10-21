/**
 * Draft-hint matching shared by the browser cleanup and its tests.
 *
 * The host kills the desktop renderer mid-turn; the renderer's last throttled
 * draft write can be a prefix of the message that was already sent. On the next
 * load the composer restores that prefix into the input box.
 *
 * A stored snapshot is stale when it is a non-empty prefix of the session's
 * last human message. IME input needs a second rule: the last throttled write
 * can end in unconverted pinyin ("…直接cho") that the final message never
 * contains, so a long shared prefix with a non-empty draft identifies the same
 * message too. Genuinely unrelated drafts are left alone.
 */
const MIN_COMMON_PREFIX = 4

function commonPrefixLength(left, right) {
  const a = Array.from(left)
  const b = Array.from(right)
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a[index] === b[index]) index += 1
  return index
}

export function isStaleDraft(draftText, lastUserText) {
  if (typeof draftText !== 'string' || draftText === '') return false
  if (typeof lastUserText !== 'string' || lastUserText === '') return false
  if (lastUserText.startsWith(draftText)) return true
  return commonPrefixLength(draftText, lastUserText) >= MIN_COMMON_PREFIX
}

/**
 * Rewrite one persisted conversation entry with an empty draft when it matches.
 * Unknown shapes are left untouched.
 *
 * @param raw - the `localStorage` value for `dsh.conversation.<sessionId>`.
 * @param lastUserText - the session's last human message.
 * @returns the replacement JSON string, or null when nothing should change.
 */
export function clearStaleDraftJson(raw, lastUserText) {
  let stored
  try {
    stored = JSON.parse(raw)
  } catch {
    return null
  }
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null
  const draft = stored.draft
  const text = typeof draft === 'string' ? draft : draft?.text
  if (!isStaleDraft(text, lastUserText)) return null
  const nextDraft = typeof draft === 'string' ? '' : { ...(draft ?? {}), text: '', references: [] }
  return JSON.stringify({ ...stored, draft: nextDraft })
}
