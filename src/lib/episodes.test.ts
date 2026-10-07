import { describe, expect, it } from 'vitest';

import type { Alert } from './alerts.ts';
import {
  formatDuration,
  observeEpisodes,
  type Episode,
  type Observed,
  type Sighting,
} from './episodes.ts';
import type { Level } from './status.ts';

const MIN = 60_000;

function trouble(
  level: Level = 'major',
  detail = 'Actions',
  group = 'service:github',
  subject = 'GitHub',
): Alert {
  return {
    key: `${group}:${level}`,
    group,
    subject,
    level,
    incidents: [],
    title: `${subject}: ${level}`,
    detail,
    link: { label: 'View status page', url: 'https://www.githubstatus.com' },
  };
}

const bad = (alert: Alert): Sighting => ({ group: alert.group, kind: 'bad', alert });
const fine = (group = 'service:github'): Sighting => ({ group, kind: 'fine' });
const blind = (group = 'service:github'): Sighting => ({ group, kind: 'blind' });

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

describe('observeEpisodes: opening', () => {
  it('opens an episode when a service is first seen in trouble', () => {
    const [seen] = run([5 * MIN, bad(trouble('major', 'Actions'))]);
    expect(seen?.open).toEqual([
      {
        group: 'service:github',
        subject: 'GitHub',
        startedAt: 5 * MIN,
        peak: 'major',
        detail: 'Actions',
        link: { label: 'View status page', url: 'https://www.githubstatus.com' },
      },
    ]);
    expect(seen?.resolved).toEqual([]);
  });

  it('says nothing about a service that was never in trouble', () => {
    const [seen] = run([0, fine()]);
    expect(seen).toEqual({ open: [], resolved: [] });
  });

  it('keeps one episode per service, and keeps them apart', () => {
    const cursor = trouble('degraded', 'Grok Bot', 'service:cursor', 'Cursor');
    const [seen] = run([0, bad(trouble()), bad(cursor)]);
    expect(seen?.open.map((episode) => episode.subject)).toEqual(['GitHub', 'Cursor']);
  });
});

describe('observeEpisodes: while it lasts', () => {
  it('keeps the start, raises the peak and follows what the vendor says', () => {
    const { open } = last(
      run(
        [0, bad(trouble('degraded', 'Investigating'))],
        [1 * MIN, bad(trouble('major', 'Identified'))],
      ),
    );
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ startedAt: 0, peak: 'major', detail: 'Identified' });
  });

  it('does not lower the peak when it eases', () => {
    const { open } = last(run([0, bad(trouble('major'))], [1 * MIN, bad(trouble('degraded'))]));
    expect(open[0]?.peak).toBe('major');
  });
});

describe('observeEpisodes: ending', () => {
  it('turns a fine reading after trouble into a resolved card', () => {
    const { open, resolved } = last(run([0, bad(trouble('major', 'Actions'))], [12 * MIN, fine()]));
    expect(open).toEqual([]);
    expect(resolved).toEqual([
      {
        key: `resolved:service:github:${String(12 * MIN)}`,
        group: 'service:github',
        subject: 'GitHub',
        level: 'operational',
        incidents: [],
        title: 'GitHub: resolved',
        detail: 'Actions · major outage, seen for 12 min',
        link: { label: 'View status page', url: 'https://www.githubstatus.com' },
      },
    ]);
  });

  it('reports the worst it got, not how it ended', () => {
    const { resolved } = last(
      run(
        [0, bad(trouble('partial', 'Delayed jobs'))],
        [1 * MIN, bad(trouble('degraded', 'Delayed jobs'))],
        [2 * MIN, fine()],
      ),
    );
    expect(resolved[0]?.detail).toBe('Delayed jobs · partial outage, seen for 2 min');
  });

  it('leaves out the vendor’s words when it had none, with no stray separator', () => {
    const { resolved } = last(run([0, bad(trouble('degraded', ''))], [3 * MIN, fine()]));
    expect(resolved[0]?.detail).toBe('degraded, seen for 3 min');
  });

  it('announces it once', () => {
    const seen = run([0, bad(trouble())], [1 * MIN, fine()], [2 * MIN, fine()]);
    expect(seen[1]?.resolved).toHaveLength(1);
    expect(seen[2]?.resolved).toEqual([]);
  });

  it('starts a fresh episode when it goes bad again', () => {
    const { open } = last(
      run([0, bad(trouble())], [1 * MIN, fine()], [10 * MIN, bad(trouble('degraded'))]),
    );
    expect(open[0]).toMatchObject({ startedAt: 10 * MIN, peak: 'degraded' });
  });

  it('resolves each service on its own', () => {
    const cursor = trouble('degraded', 'Grok Bot', 'service:cursor', 'Cursor');
    const { open, resolved } = last(
      run([0, bad(trouble()), bad(cursor)], [1 * MIN, fine(), bad(cursor)]),
    );
    expect(resolved.map((card) => card.subject)).toEqual(['GitHub']);
    expect(open.map((episode) => episode.subject)).toEqual(['Cursor']);
  });
});

describe('observeEpisodes: what is not an ending', () => {
  it('does not end when the page cannot be read', () => {
    const { open, resolved } = last(run([0, bad(trouble())], [1 * MIN, blind()]));
    expect(resolved).toEqual([]);
    expect(open).toHaveLength(1);
  });

  it('still ends later, timed from when it began rather than when sight returned', () => {
    const { resolved } = last(
      run([0, bad(trouble())], [1 * MIN, blind()], [2 * MIN, blind()], [30 * MIN, fine()]),
    );
    expect(resolved[0]?.detail).toContain('seen for 30 min');
  });

  it('does not end when the service is dropped from the list, and forgets it', () => {
    const { open, resolved } = last(run([0, bad(trouble())], [1 * MIN]));
    expect(resolved).toEqual([]);
    expect(open).toEqual([]);
  });

  it('does not invent an ending for a service that was blind from the start', () => {
    expect(last(run([0, blind()], [1 * MIN, fine()])).resolved).toEqual([]);
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
