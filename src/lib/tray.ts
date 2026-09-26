/**
 * The tray menu's status line.
 *
 * Composed here rather than in Rust so it is pure and testable; `lib.rs` only
 * applies the string. The interesting part is the wording, and that deserves
 * tests rather than a manual look at a menu.
 */

import type { Connectivity } from './connectivity.ts';
import { LEVEL_LABELS, LEVELS, type Level } from './status.ts';

/** The tray line's override while the connection is the problem, else `null`. */
function connectivityTrayLine(status: Connectivity): string | null {
  switch (status) {
    case 'offline':
      return 'Offline: no internet connection';
    case 'portal':
      return 'Offline: Wi-Fi sign-in required';
    case 'checking':
    case 'online':
      return null;
  }
}

export interface TrayEntry {
  readonly name: string;
  /** `null` while its first reading is still on the way. */
  readonly level: Level | null;
}

/** How many problem services the line names before summarizing the rest. */
const MAX_NAMED = 2;

/**
 * One line for the disabled item at the top of the tray menu.
 *
 * No connection overrides everything else. While offline every service would
 * read as unknown, and naming them one by one would blame vendors for a
 * problem that is local.
 *
 * Everything fine collapses to a count ("All 3 operational"). Anything else
 * names the services that aren't, worst first, because the line exists to
 * answer "is it them or is it me?" without opening the panel. Ties keep the
 * order the services were configured in.
 */
export function formatTrayStatus(
  entries: readonly TrayEntry[],
  connectivity: Connectivity = 'online',
): string {
  const offline = connectivityTrayLine(connectivity);
  if (offline !== null) return offline;
  if (entries.length === 0) return 'No services yet';
  if (entries.every((entry) => entry.level === null)) return 'Checking…';

  const problems = entries
    .map((entry, index) => ({ entry, level: entry.level, index }))
    .filter((item): item is typeof item & { level: Level } => item.level !== null)
    .filter(({ level }) => level !== 'operational')
    .sort((a, b) => severity(b.level) - severity(a.level) || a.index - b.index)
    .map(({ entry, level }) => ({ name: entry.name, level }));

  if (problems.length === 0) {
    return entries.length === 1
      ? `${entries[0]?.name ?? ''} operational`
      : `All ${String(entries.length)} operational`;
  }

  const named = problems
    .slice(0, MAX_NAMED)
    .map((entry) => `${entry.name}: ${LEVEL_LABELS[entry.level]}`);
  const rest = problems.length - MAX_NAMED;
  if (rest > 0) named.push(`+${String(rest)} more`);
  return named.join(' · ');
}

/** Position in `LEVELS`, which is ordered best to worst. */
function severity(level: Level): number {
  return LEVELS.indexOf(level);
}
