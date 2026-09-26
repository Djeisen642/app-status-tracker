/**
 * `settings.json`: the list of watched services.
 *
 * Reading repairs rather than refuses, so a hand-edited or half-broken file
 * never stops the app from starting. But repairing what is *used* is not the
 * same as being allowed to overwrite what is *there*, and an adversarial
 * review caught the difference twice:
 *
 * - An entry this build doesn't understand (a newer build's `kind`, a hand
 *   edit with an `http://` address) used to be dropped on read, and so deleted
 *   from disk by the next add or remove. It is now kept in `others` and written
 *   back untouched, as are top-level keys this build doesn't know.
 * - A file that isn't settings at all (not JSON, no `services` list) used to
 *   fall back to the defaults, which the next change then saved over it. Now
 *   it reads as not `writable`, and the app refuses to change the list until
 *   the file is fixed or removed: the defaults run, but only in memory.
 */

import { DEFAULT_SERVICES, type ServiceConfig } from './services.ts';

export interface Settings {
  readonly services: readonly ServiceConfig[];
  /** Entries in `services` this build doesn't understand, kept as they were. */
  readonly others: readonly unknown[];
  /** Top-level keys other than `services`, kept as they were. */
  readonly extra: Readonly<Record<string, unknown>>;
}

export const DEFAULT_SETTINGS: Settings = { services: DEFAULT_SERVICES, others: [], extra: {} };

export interface LoadedSettings {
  readonly settings: Settings;
  /** `false` when saving would overwrite a file that couldn't be understood. */
  readonly writable: boolean;
}

/** Read the file's text; `null` (no file yet) is a first launch. */
export function readSettings(text: string | null): LoadedSettings {
  if (text === null) return { settings: DEFAULT_SETTINGS, writable: true };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { settings: DEFAULT_SETTINGS, writable: false };
  }
  if (!isRecord(json) || !Array.isArray(json.services)) {
    return { settings: DEFAULT_SETTINGS, writable: false };
  }

  const { services: entries, ...extra } = json;
  const seen = new Set<string>();
  const services: ServiceConfig[] = [];
  const others: unknown[] = [];
  for (const entry of entries as unknown[]) {
    const service = parseService(entry);
    // Duplicate ids would share one poll state; the first one is used, the
    // rest are kept on disk untouched.
    if (service === null || seen.has(service.id)) {
      others.push(entry);
      continue;
    }
    seen.add(service.id);
    services.push(service);
  }
  // An empty list is kept: removing every service is a choice, not damage.
  return { settings: { services, others, extra }, writable: true };
}

/** Just the settings, for callers that don't write. */
export function parseSettings(text: string | null): Settings {
  return readSettings(text).settings;
}

/** The file's text. Entries this build didn't understand go back after the ones it did. */
export function serializeSettings(settings: Settings): string {
  const json = { ...settings.extra, services: [...settings.services, ...settings.others] };
  return `${JSON.stringify(json, null, 2)}\n`;
}

function parseService(entry: unknown): ServiceConfig | null {
  if (!isRecord(entry)) return null;
  const { id, name, kind, pageUrl, components } = entry;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name.trim() === '') {
    return null;
  }
  if (kind !== 'statuspage' || typeof pageUrl !== 'string' || !isHttps(pageUrl)) return null;

  const watched = Array.isArray(components)
    ? components.filter((component): component is string => typeof component === 'string')
    : [];
  return {
    id,
    name: name.trim(),
    kind,
    pageUrl,
    ...(watched.length > 0 ? { components: watched } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
