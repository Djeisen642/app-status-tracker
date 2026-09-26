/**
 * The status model every adapter normalizes into.
 *
 * Status pages disagree about vocabulary (Statuspage says `major_outage`, RSS
 * says nothing machine-readable at all), so each adapter maps into these six
 * levels and nothing downstream ever sees a provider's own words.
 */

/**
 * Ordered by urgency, least to most: what should win when several things are
 * true at once (the headline, the tray line, a page's rollup).
 *
 * `unknown` means the app is blind, and it must never be quietly treated as
 * `operational`, which is why it ranks above it and above maintenance. But it
 * ranks *below* a known outage: "can't read Linear's status" must not take the
 * headline from "GitHub is having a major outage". It used to rank worst of
 * all, and an adversarial review caught exactly that: the neutral grey
 * headline hid a real red outage behind "1 more with issues".
 */
export const LEVELS = [
  'operational',
  'maintenance',
  'unknown',
  'degraded',
  'partial',
  'major',
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

/** `true` when `a` is strictly more urgent than `b`. */
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
