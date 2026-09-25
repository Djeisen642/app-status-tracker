/**
 * The tray menu's status line.
 *
 * Composed here rather than in Rust so it is pure and testable; `lib.rs` only
 * applies the string. The interesting part is the wording, and that deserves
 * tests rather than a manual look at a menu.
 */

import { LEVEL_LABELS, LEVELS, type Level } from './status.ts';

export interface TrayEntry {
  readonly name: string;
  readonly level: Level;
}

/** How many problem services the line names before summarizing the rest. */
const MAX_NAMED = 2;

/**
 * One line for the disabled item at the top of the tray menu.
 *
 * Everything fine collapses to a count ("All 3 operational"). Anything else
 * names the services that aren't, worst first, because the line exists to
 * answer "is it them or is it me?" without opening the panel. Ties keep the
 * order the services were configured in.
 */
export function formatTrayStatus(entries: readonly TrayEntry[]): string {
  if (entries.length === 0) return 'No services yet';

  const problems = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.level !== 'operational')
    .sort((a, b) => severity(b.entry.level) - severity(a.entry.level) || a.index - b.index)
    .map(({ entry }) => entry);

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
