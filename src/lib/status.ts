/**
 * The status model every adapter normalizes into.
 *
 * Status pages disagree about vocabulary (Statuspage says `major_outage`, RSS
 * says nothing machine-readable at all), so each adapter maps into these six
 * levels and nothing downstream ever sees a provider's own words.
 */

/**
 * Ordered from best to worst. `unknown` is the worst on purpose: a fetch that
 * failed means the app is blind, and a tracker that shows green while blind is
 * worse than none. It must never be quietly treated as `operational`.
 */
export const LEVELS = [
  'operational',
  'maintenance',
  'degraded',
  'partial',
  'major',
  'unknown',
] as const;

export type Level = (typeof LEVELS)[number];

/** How a level reads in the tray line and the panel. */
export const LEVEL_LABELS: Readonly<Record<Level, string>> = {
  operational: 'operational',
  maintenance: 'maintenance',
  degraded: 'degraded',
  partial: 'partial outage',
  major: 'major outage',
  unknown: 'unknown',
};

/** `true` when `a` is strictly worse than `b`. */
export function isWorse(a: Level, b: Level): boolean {
  return LEVELS.indexOf(a) > LEVELS.indexOf(b);
}

/**
 * The worst of several levels, or `operational` for none.
 *
 * An empty list is `operational` rather than `unknown` because "no components
 * matched" is a configuration question, not a failed fetch; the caller that
 * knows which one it is decides whether to say so.
 */
export function worstLevel(levels: Iterable<Level>): Level {
  let worst: Level = 'operational';
  for (const level of levels) {
    if (isWorse(level, worst)) worst = level;
  }
  return worst;
}
