import { describe, expect, it } from 'vitest';

import type { Alert } from './alerts.ts';
import {
  formatDuration,
  groupOf,
  observeEpisodes,
  resolvedAlert,
  type Episode,
  type Observed,
  type Sighting,
} from './episodes.ts';
import type { Level } from './status.ts';

const MIN = 60_000;
const GITHUB = 'service:github';
const LINK = { label: 'View status page', url: 'https://www.githubstatus.com' };

function trouble(
  level: Level = 'major',
  detail = 'Actions',
  incidents: readonly string[] = [],
  group = GITHUB,
): Alert {
  return {
    key: `${group}:${level}`,
    group,
    level,
    incidents,
    title: `${group}: ${level}`,
    detail,
    link: LINK,
  };
}

/** A reading of trouble, fetched at `readAt`. */
const bad = (alert: Alert, readAt: number, subject = 'GitHub'): Sighting => ({
  kind: 'bad',
  alert,
  subject,
  readAt,
});
const fine = (group = GITHUB): Sighting => ({ kind: 'fine', group });
const blind = (group = GITHUB): Sighting => ({ kind: 'blind', group });
const maintenance = (group = GITHUB): Sighting => ({ kind: 'maintenance', group });

/** Feed a run of checks, each at its own time, through the memory. */
function run(...checks: readonly [number, ...Sighting[]][]): Observed[] {
  const seen: Observed[] = [];
  let open: readonly Episode[] = [];
  for (const [at, ...sightings] of checks) {
    const observed = observeEpisodes(open, sightings, at);
    open = observed.open;
    seen.push(observed);
  }
  return seen;
}

function last<T>(items: readonly T[]): T {
  const item = items.at(-1);
  if (item === undefined) throw new Error('nothing');
  return item;
}

/** The card for the trouble that the last of these checks saw end. */
function cardFor(...checks: readonly [number, ...Sighting[]][]): Alert {
  const resolution = last(run(...checks)).resolved[0];
  if (resolution === undefined) throw new Error('nothing ended');
  return resolvedAlert(resolution);
}

describe('observeEpisodes: opening', () => {
  it('opens an episode when a service is first seen in trouble, timed from the reading', () => {
    const [seen] = run([9 * MIN, bad(trouble('major', 'Actions'), 5 * MIN)]);
    expect(seen?.open).toEqual([
      {
        group: GITHUB,
        subject: 'GitHub',
        startedAt: 5 * MIN,
        lastSeenAt: 5 * MIN,
        peak: 'major',
        detail: 'Actions',
        fromIncident: false,
        link: LINK,
      },
    ]);
    expect(seen?.resolved).toEqual([]);
  });

  it('says nothing about a service that was never in trouble', () => {
    const [seen] = run([0, fine()]);
    expect(seen).toEqual({ open: [], resolved: [] });
  });

  it('keeps one episode per service, and keeps them apart', () => {
    const cursor = trouble('degraded', 'Grok Bot', [], 'service:cursor');
    const [seen] = run([0, bad(trouble(), 0), bad(cursor, 0, 'Cursor')]);
    expect(seen?.open.map((episode) => episode.subject)).toEqual(['GitHub', 'Cursor']);
  });
});

describe('observeEpisodes: while it lasts', () => {
  it('keeps the start, raises the peak and follows what the vendor says', () => {
    const { open } = last(
      run(
        [0, bad(trouble('degraded', 'Investigating'), 0)],
        [1 * MIN, bad(trouble('major', 'Identified'), 1 * MIN)],
      ),
    );
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      startedAt: 0,
      lastSeenAt: 1 * MIN,
      peak: 'major',
      detail: 'Identified',
    });
  });

  it('does not lower the peak when it eases', () => {
    const { open } = last(
      run([0, bad(trouble('major'), 0)], [1 * MIN, bad(trouble('degraded'), 1 * MIN)]),
    );
    expect(open[0]?.peak).toBe('major');
  });

  it('only moves lastSeenAt on a fresh reading, not on a check that repeated a stale one', () => {
    const { open } = last(
      run(
        [0, bad(trouble(), 0)],
        // The connection was down for hours: the checks went on, the readings did not.
        [3 * 60 * MIN, bad(trouble(), 0)],
      ),
    );
    expect(open[0]?.lastSeenAt).toBe(0);
  });

  it('keeps an incident’s name when a later reading has only the component list', () => {
    const { open } = last(
      run(
        [0, bad(trouble('degraded', 'Elevated errors for Copilot', ['inc1']), 0)],
        [1 * MIN, bad(trouble('degraded', 'Copilot', []), 1 * MIN)],
      ),
    );
    expect(open[0]?.detail).toBe('Elevated errors for Copilot');
  });

  it('takes a newer incident’s name over an older one', () => {
    const { open } = last(
      run(
        [0, bad(trouble('degraded', 'First', ['a']), 0)],
        [1 * MIN, bad(trouble('degraded', 'Second', ['a', 'b']), 1 * MIN)],
      ),
    );
    expect(open[0]?.detail).toBe('Second');
  });

  it('takes an incident’s name over the component list that came first', () => {
    const { open } = last(
      run(
        [0, bad(trouble('degraded', 'Copilot', []), 0)],
        [1 * MIN, bad(trouble('degraded', 'Elevated errors', ['inc1']), 1 * MIN)],
      ),
    );
    expect(open[0]?.detail).toBe('Elevated errors');
  });
});

describe('observeEpisodes: ending', () => {
  it('closes the episode on a fine reading, handing back it and when it ended', () => {
    const { open, resolved } = last(
      run([0, bad(trouble('major', 'Actions'), 0)], [12 * MIN, fine()]),
    );
    expect(open).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.endedAt).toBe(12 * MIN);
    expect(resolved[0]?.episode).toMatchObject({ group: GITHUB, startedAt: 0, peak: 'major' });
  });

  it('announces it once', () => {
    const seen = run([0, bad(trouble(), 0)], [1 * MIN, fine()], [2 * MIN, fine()]);
    expect(seen[1]?.resolved).toHaveLength(1);
    expect(seen[2]?.resolved).toEqual([]);
  });

  it('starts a fresh episode when it goes bad again', () => {
    const { open } = last(
      run(
        [0, bad(trouble(), 0)],
        [1 * MIN, fine()],
        [10 * MIN, bad(trouble('degraded'), 10 * MIN)],
      ),
    );
    expect(open[0]).toMatchObject({ startedAt: 10 * MIN, peak: 'degraded' });
  });

  it('resolves each service on its own', () => {
    const cursor = trouble('degraded', 'Grok Bot', [], 'service:cursor');
    const { open, resolved } = last(
      run(
        [0, bad(trouble(), 0), bad(cursor, 0, 'Cursor')],
        [1 * MIN, fine(), bad(cursor, 1 * MIN, 'Cursor')],
      ),
    );
    expect(resolved.map((r) => r.episode.subject)).toEqual(['GitHub']);
    expect(open.map((episode) => episode.subject)).toEqual(['Cursor']);
  });
});

describe('observeEpisodes: what is not an ending', () => {
  it('does not end when the page cannot be read', () => {
    const { open, resolved } = last(run([0, bad(trouble(), 0)], [1 * MIN, blind()]));
    expect(resolved).toEqual([]);
    expect(open).toHaveLength(1);
  });

  it('does not end in maintenance, which is not an all-clear', () => {
    const { open, resolved } = last(run([0, bad(trouble(), 0)], [1 * MIN, maintenance()]));
    expect(resolved).toEqual([]);
    expect(open).toHaveLength(1);
  });

  it('ends later, once it is really fine, with the gap left out of the time it was seen', () => {
    const card = cardFor(
      [0, bad(trouble(), 0)],
      [1 * MIN, blind()],
      [2 * MIN, maintenance()],
      [30 * MIN, fine()],
    );
    expect(card.detail).toContain('seen for less than a minute');
  });

  it('does not end when the service is dropped from the list, and forgets it', () => {
    const { open, resolved } = last(run([0, bad(trouble(), 0)], [1 * MIN]));
    expect(resolved).toEqual([]);
    expect(open).toEqual([]);
  });

  it('does not invent an ending for a service that was blind from the start', () => {
    expect(last(run([0, blind()], [1 * MIN, fine()])).resolved).toEqual([]);
  });
});

describe('resolvedAlert', () => {
  it('is a card in the good tone, naming the service and linking its page', () => {
    expect(
      cardFor(
        [0, bad(trouble('major', 'Actions'), 0)],
        [12 * MIN, bad(trouble('major'), 12 * MIN)],
        [13 * MIN, fine()],
      ),
    ).toEqual({
      key: `resolved:${GITHUB}:${String(13 * MIN)}`,
      group: GITHUB,
      level: 'operational',
      incidents: [],
      title: 'GitHub: resolved',
      detail: 'Actions · major outage, seen for 12 min',
      link: LINK,
    });
  });

  it('reports the worst it got, not how it ended', () => {
    const card = cardFor(
      [0, bad(trouble('partial', 'Delayed jobs'), 0)],
      [1 * MIN, bad(trouble('degraded', 'Delayed jobs'), 1 * MIN)],
      [2 * MIN, fine()],
    );
    expect(card.detail).toBe('Delayed jobs · partial outage, seen for 1 min');
  });

  it('times it to the last reading that saw it, so a weekend asleep is not a weekend of outage', () => {
    const card = cardFor(
      [0, bad(trouble('major'), 0)],
      [10 * MIN, bad(trouble('major'), 10 * MIN)],
      [2 * 24 * 60 * MIN, fine()],
    );
    expect(card.detail).toContain('seen for 10 min');
  });

  it('leaves out the vendor’s words when it had none, with no stray separator', () => {
    const card = cardFor(
      [0, bad(trouble('degraded', ''), 0)],
      [3 * MIN, bad(trouble('degraded', ''), 3 * MIN)],
      [4 * MIN, fine()],
    );
    expect(card.detail).toBe('degraded, seen for 3 min');
  });
});

describe('groupOf', () => {
  it('reads the group from the alert for trouble, and from the sighting otherwise', () => {
    expect(groupOf(bad(trouble(), 0))).toBe(GITHUB);
    expect(groupOf(fine('x'))).toBe('x');
    expect(groupOf(blind('y'))).toBe('y');
    expect(groupOf(maintenance('z'))).toBe('z');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, 'less than a minute'],
    [59_999, 'less than a minute'],
    [-5, 'less than a minute'],
    [MIN, '1 min'],
    [59 * MIN + 59_000, '59 min'],
    [60 * MIN, '1 h'],
    [185 * MIN, '3 h 5 min'],
    [24 * 60 * MIN, '1 day'],
    [50 * 60 * MIN, '2 days'],
  ])('%d ms reads as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
