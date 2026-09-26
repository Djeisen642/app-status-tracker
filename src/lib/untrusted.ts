/**
 * Guards for data from outside the app: status-page responses, the settings
 * file someone may have hand-edited, a redirect's `Location`. One copy of each,
 * so the adapter, the settings reader and the add check can't drift apart on
 * what counts as an object or an https address.
 */

/** A plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The origin of `url` (`https://host[:port]`), or `null` if it isn't a URL. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The origin of `url` if it is https, else `null`. */
export function httpsOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}
