/**
 * Tool results must be lossless JSON. Live sessions expose fields such as
 * `header.cwd` as `undefined`, and `undefined` object properties are not
 * lossless JSON values; the tool registry rejects the whole result.
 *
 * Stringify/parse is deliberate: it drops `undefined`, normalizes branded
 * primitive wrappers, and rejects cycles/BigInt with a structured error rather
 * than letting the tool registry turn the call into an unhelpful failure.
 */
export function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    return {
      ok: false,
      code: 'output-not-serializable',
      message: `The restart coordinator returned a value that is not lossless JSON: ${String(error?.message ?? error)}`,
    }
  }
}
