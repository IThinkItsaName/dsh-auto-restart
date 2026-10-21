/**
 * Build the resume message the Chat renders as an injected notice.
 *
 * A `user/message` whose `source.kind` is not `user` is classified by the Chat
 * as context, not as a human turn; `form: 'notice'` selects the notice row (the
 * same presentation background-job completion messages use). The Agent still
 * receives the text as a user-role turn, so the resumed session keeps working.
 */
export function noticeMessageInput({ text, restartId }) {
  return {
    content: [{ type: 'text', text }],
    source: {
      kind: 'dsh-auto-restart',
      form: 'notice',
      summary: `DSH restarted (${restartId})`,
    },
  }
}
