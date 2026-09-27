/**
 * The services being watched: what they are, when each is due, and what one
 * fetch means for its state.
 *
 * Pure, like everything in `lib/`. The controller asks `isDue`, hands the
 * result of the fetch to `applyFetch`, and renders `displayLevel`.
 */

import type { Alert } from './alerts.ts';
import type { Connectivity } from './connectivity.ts';
import { parseStatuspageSummary, type Snapshot } from './adapters/statuspage.ts';
import { withJitter } from './jitter.ts';
import { LEVEL_LABELS, LEVELS, type Level } from './status.ts';

export interface ServiceConfig {
  readonly id: string;
  readonly name: string;
  readonly kind: 'statuspage';
  /** The human-facing status page: what the popup links to. */
  readonly pageUrl: string;
  /** Component names to watch. Unset watches every component on the page. */
  readonly components?: readonly string[];
}

/**
 * Built in until the settings panel exists (phase 3). Only services whose
 * adapter has been checked against a real capture belong here; both of these
 * are in `fixtures/statuspage/`.
 */
export const DEFAULT_SERVICES: readonly ServiceConfig[] = [
  { id: 'github', name: 'GitHub', kind: 'statuspage', pageUrl: 'https://www.githubstatus.com' },
  { id: 'cursor', name: 'Cursor', kind: 'statuspage', pageUrl: 'https://status.cursor.com' },
];

/** The API behind the page. */
export function apiUrl(service: ServiceConfig): string {
  return summaryUrl(service.pageUrl);
}

/** The Statuspage summary behind a status page's address. */
export function summaryUrl(pageUrl: string): string {
  return `${pageUrl.replace(/\/+$/, '')}/api/v2/summary.json`;
}

/** What one fetch saw, exactly as the bridge reports it. */
export type FetchOutcome =
  | { kind: 'response'; status: number; etag: string | null; url: string; body: string }
  | { kind: 'error'; message: string };

export interface ServiceState {
  /** The last good reading, kept through a single failed fetch. */
  readonly snapshot: Snapshot | null;
  readonly etag: string | null;
  /** Consecutive failed fetches. */
  readonly failures: number;
  readonly lastError: string | null;
  /** Epoch ms when the next fetch is due. */
  readonly nextAt: number;
}

export const INITIAL_SERVICE: ServiceState = {
  snapshot: null,
  etag: null,
  failures: 0,
  lastError: null,
  nextAt: 0,
};

/** Status summaries are cached for about a minute; asking more often gains nothing. */
export const POLL_INTERVAL = 60_000;

/** The longest a failing service waits between attempts, before jitter. */
export const MAX_BACKOFF = 15 * 60_000;

/** Room added on top of every scheduled poll, so many watched pages (and many
 * copies of this app) don't all land on the same vendor on the same tick. */
export const POLL_JITTER = 10_000;

/** Failed fetches in a row before a service reads as unknown. Same reasoning as the connection check. */
export const UNKNOWN_AFTER = 2;

export function isDue(state: ServiceState, now: number): boolean {
  return now >= state.nextAt;
}

/** Doubling from the poll interval, capped, so a dead page isn't hammered. */
export function backoff(failures: number): number {
  return Math.min(POLL_INTERVAL * 2 ** Math.max(0, failures - 1), MAX_BACKOFF);
}

/** Fold one fetch into the service's state. */
export function applyFetch(
  service: ServiceConfig,
  state: ServiceState,
  outcome: FetchOutcome,
  now: number,
  rand: () => number = Math.random,
): ServiceState {
  const fail = (message: string): ServiceState => {
    const failures = state.failures + 1;
    return {
      ...state,
      failures,
      lastError: message,
      nextAt: now + withJitter(backoff(failures), POLL_JITTER, rand),
    };
  };
  const succeed = (snapshot: Snapshot | null, etag: string | null): ServiceState => ({
    snapshot,
    etag,
    failures: 0,
    lastError: null,
    nextAt: now + withJitter(POLL_INTERVAL, POLL_JITTER, rand),
  });

  if (outcome.kind === 'error') return fail(outcome.message);
  // Unchanged since the ETag we sent: the reading we have is still current.
  if (outcome.status === 304 && state.snapshot !== null) return succeed(state.snapshot, state.etag);
  if (outcome.status !== 200) return fail(`The status page answered ${String(outcome.status)}.`);

  const parsed = parseStatuspageSummary(outcome.body, service.components);
  if (!parsed.ok) return fail(parsed.error);
  return succeed(parsed.snapshot, outcome.etag);
}

/** `null` while the first reading is still on its way. */
export function displayLevel(state: ServiceState): Level | null {
  if (state.failures >= UNKNOWN_AFTER) return 'unknown';
  if (state.snapshot === null) return state.failures > 0 ? 'unknown' : null;
  return state.snapshot.level;
}

/** Levels that raise the popup. Maintenance is scheduled; unknown means the app can't see. */
const ALERTING: ReadonlySet<Level> = new Set<Level>(['degraded', 'partial', 'major']);

/**
 * The service's alert for the popup, or `null` while it's fine.
 *
 * Grouped by service, carrying the level and open incidents, so `reconcile`
 * can tell a worse level or a new incident (pop again) from the same outage
 * easing or moving on (stay quiet).
 */
export function serviceAlert(service: ServiceConfig, state: ServiceState): Alert | null {
  const level = displayLevel(state);
  const snapshot = state.snapshot;
  if (level === null || snapshot === null || !ALERTING.has(level)) return null;

  const incidentIds = snapshot.incidents.map((incident) => incident.id).sort();
  return {
    key: ['service', service.id, level, ...incidentIds].join(':'),
    group: `service:${service.id}`,
    level,
    incidents: incidentIds,
    title: `${service.name}: ${LEVEL_LABELS[level]}`,
    detail: serviceDetail(snapshot),
    link: { label: 'View status page', url: service.pageUrl },
  };
}

/** The most specific thing there is to say: the incident, else what's affected. */
export function serviceDetail(snapshot: Snapshot): string {
  const incident = snapshot.incidents[0];
  if (incident !== undefined) return incident.name;

  const affected = snapshot.components
    .filter((component) => component.level !== 'operational')
    .map((component) => component.name);
  if (affected.length > 0) {
    const shown = affected.slice(0, 3).join(', ');
    return affected.length > 3 ? `${shown} and ${String(affected.length - 3)} more` : shown;
  }
  return snapshot.description;
}

/** The small print under a service's name in the panel. */
export function serviceSubtitle(state: ServiceState, online: boolean): string | null {
  if (!online) return null;
  if (state.failures >= UNKNOWN_AFTER && state.lastError !== null) return state.lastError;
  const level = displayLevel(state);
  if (state.snapshot === null || level === null || level === 'operational') return null;
  return serviceDetail(state.snapshot);
}

/** What a service's row says: its state for styling, its label, its small print. */
export interface RowView {
  /** A `Level`, or `checking` / `hold`. Drives the row's colour through `data-state`. */
  readonly state: Level | 'checking' | 'hold';
  readonly label: string;
  readonly subtitle: string | null;
}

/**
 * A row for this service, given the connection.
 *
 * On hold means the connection is known to be the problem (offline, or a
 * captive portal). While the connection is still being checked at launch, the
 * service is simply checking too, not on hold.
 */
export function rowView(state: ServiceState, connectivity: Connectivity): RowView {
  const held = connectivity === 'offline' || connectivity === 'portal';
  const shown = held ? 'hold' : (displayLevel(state) ?? 'checking');
  const label =
    shown === 'hold' ? 'on hold' : shown === 'checking' ? 'checking…' : LEVEL_LABELS[shown];
  return { state: shown, label, subtitle: serviceSubtitle(state, connectivity === 'online') };
}

/**
 * Where a row's state ranks for sorting, worst first. `checking` and `hold`
 * aren't the vendor's fault (nothing has answered yet, or the connection
 * itself is the problem), so they rank alongside `operational` rather than
 * bubbling up next to a real outage.
 */
function rowRank(state: RowView['state']): number {
  return LEVELS.indexOf(state === 'checking' || state === 'hold' ? 'operational' : state);
}

/**
 * Rows worst first, so a service that's actually broken surfaces above the
 * ones that are fine, without you having to scan the whole list to find it.
 * Ties, including every healthy row, keep the order they were given in (the
 * order services were added), so the list doesn't reshuffle when nothing
 * changed.
 */
export function sortByUrgency<T extends { readonly view: Pick<RowView, 'state'> }>(
  rows: readonly T[],
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rowRank(b.row.view.state) - rowRank(a.row.view.state) || a.index - b.index)
    .map(({ row }) => row);
}
