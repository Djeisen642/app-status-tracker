/**
 * The Atlassian Statuspage adapter: `/api/v2/summary.json` into a `Snapshot`.
 *
 * One adapter covers GitHub and a long tail of other vendors. The response is
 * untrusted JSON off the network, so every field is checked before use, and a
 * shape this doesn't recognize is a parse error (shown as `unknown`), never a
 * quiet green.
 *
 * What has been observed, and what hasn't: `fixtures/statuspage/` holds real
 * captures (GitHub all-green, Cursor mid-incident). Each table below says which
 * of its values a capture has confirmed; the rest are Statuspage's documented
 * vocabulary. An unrecognized value maps to `unknown` rather than being guessed.
 */

import type { Level } from '../status.ts';
import { worstLevel } from '../status.ts';

export interface Snapshot {
  /** The worst level across the components and incidents being watched. */
  readonly level: Level;
  /** The page's own one-line summary, e.g. "All Systems Operational". */
  readonly description: string;
  readonly components: readonly { readonly name: string; readonly level: Level }[];
  readonly incidents: readonly {
    readonly id: string;
    readonly name: string;
    readonly level: Level;
  }[];
}

export type ParseResult =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly error: string };

/** `component.status`. Observed: `operational`, `degraded_performance`. */
const COMPONENT_LEVELS: Readonly<Record<string, Level>> = {
  operational: 'operational',
  under_maintenance: 'maintenance',
  degraded_performance: 'degraded',
  partial_outage: 'partial',
  major_outage: 'major',
};

/** `status.indicator`, the page-wide rollup. Observed: `none`, `minor`. */
const INDICATOR_LEVELS: Readonly<Record<string, Level>> = {
  none: 'operational',
  maintenance: 'maintenance',
  minor: 'degraded',
  major: 'partial',
  critical: 'major',
};

/** `incident.impact`. Observed: `minor`. */
const IMPACT_LEVELS: Readonly<Record<string, Level>> = {
  none: 'operational',
  maintenance: 'maintenance',
  minor: 'degraded',
  major: 'partial',
  critical: 'major',
};

function lookup(table: Readonly<Record<string, Level>>, value: unknown): Level {
  return typeof value === 'string' && Object.hasOwn(table, value)
    ? (table[value] ?? 'unknown')
    : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a `summary.json` body.
 *
 * `watch` narrows it to the named components (case-insensitive). Unset, every
 * real component counts. With it set, the page-wide indicator is ignored,
 * because an incident on a component you don't use raises it too, which is
 * exactly the noise the filter exists to remove; incidents count only when
 * they name a watched component.
 */
export function parseStatuspageSummary(body: string, watch?: readonly string[]): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: 'The status page did not return JSON.' };
  }
  if (!isRecord(json) || !Array.isArray(json.components) || !isRecord(json.status)) {
    return { ok: false, error: 'The response is not a Statuspage summary.' };
  }

  const wanted =
    watch === undefined || watch.length === 0
      ? null
      : new Set(watch.map((name) => name.trim().toLowerCase()));

  const components: { id: string; name: string; level: Level }[] = [];
  for (const component of json.components) {
    if (!isRecord(component)) continue;
    const { id, name, status, group, showcase } = component;
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    // A group is a container whose status rolls up its children, which are
    // listed separately; counting it too would double-count them.
    if (group === true) continue;
    // Not shown on the page itself. GitHub uses one of these as a banner
    // ("Visit www.githubstatus.com for more information"), not a service.
    if (showcase === false) continue;
    if (wanted !== null && !wanted.has(name.trim().toLowerCase())) continue;
    components.push({ id, name, level: lookup(COMPONENT_LEVELS, status) });
  }

  if (wanted !== null && components.length === 0) {
    return { ok: false, error: `None of the watched components are on this page.` };
  }

  const watchedIds = new Set(components.map((component) => component.id));
  const incidents: { id: string; name: string; level: Level }[] = [];
  for (const incident of Array.isArray(json.incidents) ? json.incidents : []) {
    if (!isRecord(incident)) continue;
    const { id, name, impact } = incident;
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    if (wanted !== null && !touches(incident, watchedIds)) continue;
    incidents.push({ id, name, level: lookup(IMPACT_LEVELS, impact) });
  }

  const levels: Level[] = [
    ...components.map((component) => component.level),
    ...incidents.map((incident) => incident.level),
  ];
  if (wanted === null) levels.push(lookup(INDICATOR_LEVELS, json.status.indicator));

  const description = json.status.description;
  return {
    ok: true,
    snapshot: {
      level: worstLevel(levels),
      description: typeof description === 'string' ? description : '',
      components: components.map(({ name, level }) => ({ name, level })),
      incidents,
    },
  };
}

/** Does this incident name any of the watched components? */
function touches(incident: Record<string, unknown>, watchedIds: ReadonlySet<string>): boolean {
  const affected = incident.components;
  if (!Array.isArray(affected)) return false;
  return affected.some(
    (component) =>
      isRecord(component) && typeof component.id === 'string' && watchedIds.has(component.id),
  );
}
