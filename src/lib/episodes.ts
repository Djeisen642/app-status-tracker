/**
 * The app's memory of troubles: that a service was reporting an issue, and
 * that it later stopped.
 *
 * An episode opens when a check first sees a service in trouble, grows worse
 * (never better) while it lasts, and closes only when a later check positively
 * sees the service fine. Closing one is the news: it becomes a "resolved" card
 * for the popup. Everything else leaves it alone, and each of those was chosen
 * against a way of announcing a recovery that hadn't happened:
 *
 * - **Blind is not fine.** A page that can't be read (two failed fetches, or a
 *   value the adapter doesn't know) says nothing about the vendor. Status pages
 *   are the first thing to buckle in a big outage, so reading "can't reach it"
 *   as "it's back" would be the worst possible lie.
 * - **Maintenance is not fine.** The page is not quiet, so the trouble isn't
 *   over; a green all-clear would sit next to an amber panel.
 * - **Removed is not fine.** A service dropped from the list just vanishes from
 *   the sightings; its episode goes with it, silently.
 * - **The connection is not a status page.** Only services are sighted, so
 *   coming back online is not announced here; the tray and panel already say it.
 *
 * Time is the time of the *readings*, not of the checks: `lastSeenAt` moves
 * only when a fetch actually saw the trouble, so a laptop asleep or offline
 * over a weekend doesn't make a ten-minute outage "seen for two days".
 *
 * Pure and plain data, so an episode can be written to `state.json` as it is
 * when phase 2 persists popup state, and a closed one (an `Episode` and its
 * `endedAt`) is already one row of the history log. Until then a relaunch
 * forgets, and an outage begun before it is timed from the relaunch.
 */

import type { Alert, AlertLink } from './alerts.ts';
import { isWorse, LEVEL_LABELS, type Level } from './status.ts';

/** One trouble, from the first reading that saw it until the check that saw it end. */
export interface Episode {
  /** The alert group it belongs to: one service. */
  readonly group: string;
  /** Who it happened to: "GitHub". */
  readonly subject: string;
  /** Epoch ms of the first reading that saw it. The vendor may have started earlier. */
  readonly startedAt: number;
  /** Epoch ms of the latest reading that saw it still going. */
  readonly lastSeenAt: number;
  /** The worst level seen while it lasted. */
  readonly peak: Level;
  /** What the vendor said about it: the incident's name if there was one, else what is affected. */
  readonly detail: string;
  /** Whether `detail` is an incident's name, which later, vaguer readings must not replace. */
  readonly fromIncident: boolean;
  /** The page that explains it. */
  readonly link: AlertLink | null;
}

/** What one check of one service saw. */
export type Sighting =
  | {
      readonly kind: 'bad';
      readonly alert: Alert;
      /** Who it is, for the card. */
      readonly subject: string;
      /** Epoch ms of the fetch behind this reading. */
      readonly readAt: number;
    }
  | { readonly kind: 'fine'; readonly group: string }
  | { readonly kind: 'blind'; readonly group: string }
  | { readonly kind: 'maintenance'; readonly group: string };

export function groupOf(sighting: Sighting): string {
  return sighting.kind === 'bad' ? sighting.alert.group : sighting.group;
}

/** A trouble that was seen to end. */
export interface Resolution {
  readonly episode: Episode;
  /** Epoch ms of the check that saw it fine. */
  readonly endedAt: number;
}

export interface Observed {
  /** Troubles still going, or not known to have ended. */
  readonly open: readonly Episode[];
  /** The troubles that were seen to end now. */
  readonly resolved: readonly Resolution[];
}

/** Fold the latest sightings into the memory. `sightings` is every service being watched. */
export function observeEpisodes(
  open: readonly Episode[],
  sightings: readonly Sighting[],
  now: number,
): Observed {
  const known = new Map(open.map((episode) => [episode.group, episode]));
  const next: Episode[] = [];
  const resolved: Resolution[] = [];

  for (const sighting of sightings) {
    const episode = known.get(groupOf(sighting));
    switch (sighting.kind) {
      case 'bad':
        next.push(episode === undefined ? begin(sighting) : carryOn(episode, sighting));
        break;
      case 'blind':
      case 'maintenance':
        if (episode !== undefined) next.push(episode);
        break;
      case 'fine':
        if (episode !== undefined) resolved.push({ episode, endedAt: now });
        break;
    }
  }
  return { open: next, resolved };
}

function begin(sighting: Extract<Sighting, { kind: 'bad' }>): Episode {
  const { alert, subject, readAt } = sighting;
  return {
    group: alert.group,
    subject,
    startedAt: readAt,
    lastSeenAt: readAt,
    peak: alert.level,
    detail: alert.detail,
    fromIncident: alert.incidents.length > 0,
    link: alert.link,
  };
}

function carryOn(episode: Episode, sighting: Extract<Sighting, { kind: 'bad' }>): Episode {
  const { alert, readAt } = sighting;
  const named = alert.incidents.length > 0;
  // Statuspage drops an incident from the summary a poll before its components
  // clear: the incident's name is the better thing to keep, not the component
  // list that replaces it.
  const keepDetail = episode.fromIncident && !named;
  return {
    ...episode,
    lastSeenAt: Math.max(episode.lastSeenAt, readAt),
    peak: isWorse(alert.level, episode.peak) ? alert.level : episode.peak,
    detail: keepDetail ? episode.detail : alert.detail,
    fromIncident: keepDetail ? true : named,
    link: alert.link,
  };
}

/** The popup card for a trouble that ended: the shape of an alert, in the good tone. */
export function resolvedAlert({ episode, endedAt }: Resolution): Alert {
  const lasted = `${LEVEL_LABELS[episode.peak]}, seen for ${formatDuration(episode.lastSeenAt - episode.startedAt)}`;
  return {
    key: `resolved:${episode.group}:${String(endedAt)}`,
    group: episode.group,
    level: 'operational',
    incidents: [],
    title: `${episode.subject}: resolved`,
    detail: episode.detail === '' ? lasted : `${episode.detail} · ${lasted}`,
    link: episode.link,
  };
}

/** A span for a sentence: "12 min", "3 h 5 min", "2 days". Rounded down. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }
  const days = Math.floor(hours / 24);
  return `${String(days)} ${days === 1 ? 'day' : 'days'}`;
}
