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
 * - **Removed is not fine.** A service dropped from the list just vanishes from
 *   the sightings; its episode goes with it, silently.
 * - **The connection is not a status page.** Only services are sighted, so
 *   coming back online is not announced here; the tray and panel already say it.
 *
 * Pure and plain data, so it can be written to `state.json` as it is when
 * phase 2 persists popup state. Until then a relaunch forgets, and an outage
 * begun before it is timed from the relaunch.
 */

import type { Alert, AlertLink } from './alerts.ts';
import { isWorse, LEVEL_LABELS, type Level } from './status.ts';

/** One trouble, from the first check that saw it until the one that saw it end. */
export interface Episode {
  /** The alert group it belongs to: one service. */
  readonly group: string;
  /** Who it happened to: "GitHub". */
  readonly subject: string;
  /** Epoch ms of the first check that saw it. The vendor may have started earlier. */
  readonly startedAt: number;
  /** The worst level seen while it lasted. */
  readonly peak: Level;
  /** What the vendor last said about it: the incident, or what is affected. */
  readonly detail: string;
  /** The page that explains it. */
  readonly link: AlertLink | null;
}

/** What one check of one service saw. */
export type Sighting =
  | { readonly group: string; readonly kind: 'bad'; readonly alert: Alert }
  | { readonly group: string; readonly kind: 'fine' }
  | { readonly group: string; readonly kind: 'blind' };

export interface Observed {
  /** Troubles still going, or not known to have ended. */
  readonly open: readonly Episode[];
  /** One card for each trouble that was seen to end now. */
  readonly resolved: readonly Alert[];
}

/** Fold the latest sightings into the memory. `sightings` is every service being watched. */
export function observeEpisodes(
  open: readonly Episode[],
  sightings: readonly Sighting[],
  now: number,
): Observed {
  const known = new Map(open.map((episode) => [episode.group, episode]));
  const next: Episode[] = [];
  const resolved: Alert[] = [];

  for (const sighting of sightings) {
    const episode = known.get(sighting.group);
    switch (sighting.kind) {
      case 'bad':
        next.push(
          episode === undefined ? begin(sighting.alert, now) : carryOn(episode, sighting.alert),
        );
        break;
      case 'blind':
        if (episode !== undefined) next.push(episode);
        break;
      case 'fine':
        if (episode !== undefined) resolved.push(resolution(episode, now));
        break;
    }
  }
  return { open: next, resolved };
}

function begin(alert: Alert, now: number): Episode {
  return {
    group: alert.group,
    subject: alert.subject,
    startedAt: now,
    peak: alert.level,
    detail: alert.detail,
    link: alert.link,
  };
}

function carryOn(episode: Episode, alert: Alert): Episode {
  return {
    ...episode,
    peak: isWorse(alert.level, episode.peak) ? alert.level : episode.peak,
    detail: alert.detail,
    link: alert.link,
  };
}

/** The card for a trouble that ended: the same shape as an alert, in the good tone. */
function resolution(episode: Episode, now: number): Alert {
  const lasted = `${LEVEL_LABELS[episode.peak]}, seen for ${formatDuration(now - episode.startedAt)}`;
  return {
    key: `resolved:${episode.group}:${String(now)}`,
    group: episode.group,
    subject: episode.subject,
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
