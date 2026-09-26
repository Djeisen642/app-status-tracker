/**
 * `settings.json`: the list of watched services.
 *
 * `parseSettings` repairs rather than refuses, so a hand-edited or half-broken
 * file never stops the app from starting: bad entries are dropped, and a file
 * that isn't settings at all falls back to the defaults. The add form is where
 * refusing happens (`candidate.ts`), because that is where someone can act on
 * the reason.
 */

import { DEFAULT_SERVICES, type ServiceConfig } from './services.ts';

export interface Settings {
  readonly services: readonly ServiceConfig[];
}

export const DEFAULT_SETTINGS: Settings = { services: DEFAULT_SERVICES };

/** Read the file's text; `null` (no file yet) is a first launch. */
export function parseSettings(text: string | null): Settings {
  if (text === null) return DEFAULT_SETTINGS;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (
    typeof json !== 'object' ||
    json === null ||
    !Array.isArray((json as Record<string, unknown>).services)
  ) {
    return DEFAULT_SETTINGS;
  }

  const seen = new Set<string>();
  const services: ServiceConfig[] = [];
  for (const entry of (json as { services: unknown[] }).services) {
    const service = parseService(entry);
    // Duplicate ids would share one poll state; the first one wins.
    if (service === null || seen.has(service.id)) continue;
    seen.add(service.id);
    services.push(service);
  }
  // An empty list is kept: removing every service is a choice, not damage.
  return { services };
}

export function serializeSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function parseService(entry: unknown): ServiceConfig | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { id, name, kind, pageUrl, components } = entry as Record<string, unknown>;
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

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
