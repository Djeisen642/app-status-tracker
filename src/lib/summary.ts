/**
 * The panel's headline: one sentence for the state of everything.
 *
 * A status panel's first job is the answer at a glance, before any row is
 * read. So the worst thing wins the headline, it names the service when there
 * is one, and "everything is fine" is said in as many words.
 */

import type { Connectivity } from './connectivity.ts';
import { isWorse, LEVEL_LABELS, type Level } from './status.ts';
import type { TrayEntry } from './tray.ts';

/** Drives the orb's colour and the hero's tint. */
export type Tone = 'good' | 'warn' | 'bad' | 'idle';

/**
 * How loudly a level is drawn: red for an outage, amber for degraded or
 * maintenance, grey for blind. The hero and the popup both read it.
 */
export function toneOf(level: Level): Tone {
  switch (level) {
    case 'major':
    case 'partial':
      return 'bad';
    case 'degraded':
    case 'maintenance':
      return 'warn';
    case 'unknown':
      return 'idle';
    case 'operational':
      return 'good';
  }
}

export interface Headline {
  readonly tone: Tone;
  readonly title: string;
  readonly detail: string;
}

export function headline(connectivity: Connectivity, services: readonly TrayEntry[]): Headline {
  if (connectivity === 'offline') {
    return {
      tone: 'bad',
      title: 'You’re offline',
      detail: 'Status checks pick up again when you’re back.',
    };
  }
  if (connectivity === 'portal') {
    return {
      tone: 'warn',
      title: 'Wi-Fi sign-in needed',
      detail: 'This network is holding traffic until you sign in.',
    };
  }
  if (connectivity === 'checking') {
    return { tone: 'idle', title: 'Checking…', detail: 'Looking at your connection first.' };
  }
  if (services.length === 0) {
    return { tone: 'idle', title: 'Nothing to watch', detail: 'Add a status page below.' };
  }

  const known = services.filter(
    (service): service is TrayEntry & { level: Level } => service.level !== null,
  );
  const count = countOf(services.length);
  if (known.length === 0) return { tone: 'idle', title: 'Checking…', detail: count };

  const problems = known
    .filter((service) => service.level !== 'operational')
    .sort((a, b) => (isWorse(a.level, b.level) ? -1 : isWorse(b.level, a.level) ? 1 : 0));
  const worst = problems[0];

  if (worst === undefined) {
    return known.length === services.length
      ? { tone: 'good', title: 'All systems normal', detail: count }
      : { tone: 'idle', title: 'Checking…', detail: count };
  }

  const others = problems.length - 1;
  const more = others > 0 ? ` · ${String(others)} more with issues` : '';
  switch (worst.level) {
    case 'major':
    case 'partial':
      return {
        tone: toneOf(worst.level),
        title: `${worst.name} is having a ${LEVEL_LABELS[worst.level]}`,
        detail: `${count}${more}`,
      };
    case 'degraded':
      return {
        tone: toneOf(worst.level),
        title: `${worst.name} is degraded`,
        detail: `${count}${more}`,
      };
    case 'maintenance':
      return {
        tone: toneOf(worst.level),
        title: `${worst.name} is under maintenance`,
        detail: `${count}${more}`,
      };
    case 'unknown':
      return {
        tone: toneOf(worst.level),
        title: `Can’t read ${worst.name}’s status`,
        detail: `${count}${more}`,
      };
    case 'operational':
      return { tone: 'good', title: 'All systems normal', detail: count };
  }
}

function countOf(n: number): string {
  return `${String(n)} service${n === 1 ? '' : 's'} watched`;
}
