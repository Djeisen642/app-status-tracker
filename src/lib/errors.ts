/**
 * Turning thrown values into something a user can act on.
 *
 * Failures here surface in a native dialog, often while the check-in window is
 * hidden — so "[object Object]" is not an acceptable outcome. Tauri's `invoke`
 * rejects with whatever the Rust side returned, which for our commands is a
 * plain string, not an `Error`.
 */

/** Shown when a thrown value carries nothing a user could act on. */
const UNKNOWN_ERROR = 'An unknown error occurred.';

/** A human-readable description of any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  // `JSON.stringify(null)` is the string "null", which would put the literal
  // word "null" in an error dialog. Bail before that.
  if (error === null || error === undefined) return UNKNOWN_ERROR;

  try {
    const encoded = JSON.stringify(error);
    if (encoded !== undefined && encoded !== '{}') return encoded;
  } catch {
    // Circular or otherwise unserializable — fall through to the generic text.
  }

  return UNKNOWN_ERROR;
}
