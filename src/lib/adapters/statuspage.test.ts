import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseStatuspageSummary } from './statuspage.ts';

/** Real: GitHub's summary.json as served on 2026-09-25, all operational. */
const GITHUB_OPERATIONAL = readFileSync(
  new URL('../../../fixtures/statuspage/github-2026-09-25-operational.json', import.meta.url),
  'utf8',
);

/**
 * Real: Cursor's summary.json as served on 2026-09-25, mid-incident. One
 * component (Grok Bot) degraded, indicator `minor`, one open incident naming
 * that component.
 */
const CURSOR_INCIDENT = readFileSync(
  new URL('../../../fixtures/statuspage/cursor-2026-09-25-incident.json', import.meta.url),
  'utf8',
);

/**
 * The real capture with some values changed.
 *
 * SYNTHETIC. Only for exercising the mapping tables with Statuspage's
 * documented vocabulary; it proves the tables do what they say, not that the
 * API says it. Replace with a capture taken during a real incident.
 */
function variant(change: (summary: Record<string, unknown>) => void): string {
  const summary = JSON.parse(GITHUB_OPERATIONAL) as Record<string, unknown>;
  change(summary);
  return JSON.stringify(summary);
}

function setComponent(summary: Record<string, unknown>, name: string, status: string): void {
  const components = summary.components as { name: string; status: string }[];
  const component = components.find((candidate) => candidate.name === name);
  if (component === undefined) throw new Error(`No component ${name} in the fixture`);
  component.status = status;
}

function parse(body: string, watch?: readonly string[]) {
  const result = parseStatuspageSummary(body, watch);
  if (!result.ok) throw new Error(result.error);
  return result.snapshot;
}

describe('parseStatuspageSummary, against the real GitHub capture', () => {
  it('reads an all-green page as operational', () => {
    const snapshot = parse(GITHUB_OPERATIONAL);
    expect(snapshot.level).toBe('operational');
    expect(snapshot.description).toBe('All Systems Operational');
    expect(snapshot.incidents).toEqual([]);
  });

  it('skips the banner GitHub lists as a component', () => {
    const names = parse(GITHUB_OPERATIONAL).components.map((component) => component.name);
    expect(names).not.toContain('Visit www.githubstatus.com for more information');
    expect(names).toContain('Actions');
    expect(names).toHaveLength(11);
  });

  it('narrows to the watched components, ignoring case', () => {
    const snapshot = parse(GITHUB_OPERATIONAL, ['actions', 'Git Operations']);
    expect(snapshot.components.map((component) => component.name)).toEqual([
      'Git Operations',
      'Actions',
    ]);
  });

  it('refuses a filter that matches nothing, rather than watching nothing and calling it green', () => {
    expect(parseStatuspageSummary(GITHUB_OPERATIONAL, ['Actoins']).ok).toBe(false);
  });
});

describe('parseStatuspageSummary, against the real Cursor incident', () => {
  it('reads a degraded component, a minor indicator and a minor incident as degraded', () => {
    const snapshot = parse(CURSOR_INCIDENT);
    expect(snapshot.level).toBe('degraded');
    expect(snapshot.description).toBe('Partially Degraded Service');
  });

  it('names the affected component', () => {
    const degraded = parse(CURSOR_INCIDENT).components.filter(
      (component) => component.level !== 'operational',
    );
    expect(degraded).toEqual([{ name: 'Grok Bot', level: 'degraded' }]);
  });

  it('reads the open incident', () => {
    expect(parse(CURSOR_INCIDENT).incidents).toEqual([
      {
        id: 'bfcck6qks18q',
        name: 'Investigating service degradation — Grok Bot',
        level: 'degraded',
      },
    ]);
  });

  it('stays green for someone watching only the IDE, whatever the indicator says', () => {
    const snapshot = parse(CURSOR_INCIDENT, ['IDE', 'CLI']);
    expect(snapshot.level).toBe('operational');
    expect(snapshot.incidents).toEqual([]);
  });

  it('keeps the incident for someone watching the component it names', () => {
    const snapshot = parse(CURSOR_INCIDENT, ['Grok Bot']);
    expect(snapshot.level).toBe('degraded');
    expect(snapshot.incidents.map((incident) => incident.id)).toEqual(['bfcck6qks18q']);
  });
});

describe('parseStatuspageSummary, mapping (synthetic variants of the real capture)', () => {
  it('takes the worst component', () => {
    const body = variant((summary) => {
      setComponent(summary, 'Actions', 'major_outage');
      setComponent(summary, 'Pages', 'degraded_performance');
    });
    expect(parse(body).level).toBe('major');
  });

  it('maps the documented component vocabulary', () => {
    const levelFor = (status: string) =>
      parse(variant((summary) => setComponent(summary, 'Actions', status))).level;
    expect(levelFor('degraded_performance')).toBe('degraded');
    expect(levelFor('partial_outage')).toBe('partial');
    expect(levelFor('major_outage')).toBe('major');
    expect(levelFor('under_maintenance')).toBe('maintenance');
  });

  it('reads a status it has never seen as unknown, never as operational', () => {
    const body = variant((summary) => setComponent(summary, 'Actions', 'some_new_status'));
    expect(parse(body).level).toBe('unknown');
  });

  it('counts the page-wide indicator, which moves before any component does', () => {
    const body = variant((summary) => {
      summary.status = { indicator: 'minor', description: 'Minor Service Outage' };
    });
    expect(parse(body).level).toBe('degraded');
  });

  it('ignores the indicator and unrelated incidents when narrowed to components', () => {
    const body = variant((summary) => {
      summary.status = { indicator: 'major', description: 'Partial System Outage' };
      summary.incidents = [
        {
          id: 'i1',
          name: 'Codespaces unavailable',
          impact: 'major',
          components: [{ id: 'h2ftsgbw7kmk' }],
        },
      ];
      setComponent(summary, 'Codespaces', 'major_outage');
    });
    expect(parse(body, ['Actions']).level).toBe('operational');
  });

  it('counts an incident that names a watched component', () => {
    const body = variant((summary) => {
      summary.incidents = [
        { id: 'i1', name: 'Actions delays', impact: 'minor', components: [{ id: 'br0l2tvcx85d' }] },
      ];
    });
    const snapshot = parse(body, ['Actions']);
    expect(snapshot.level).toBe('degraded');
    expect(snapshot.incidents).toEqual([{ id: 'i1', name: 'Actions delays', level: 'degraded' }]);
  });
});

describe('parseStatuspageSummary, on responses that are not a summary', () => {
  it('rejects HTML, which is what a login page or an error page returns', () => {
    expect(parseStatuspageSummary('<!doctype html><title>Sign in</title>').ok).toBe(false);
  });

  it('rejects JSON of the wrong shape', () => {
    expect(parseStatuspageSummary('{"page":{}}').ok).toBe(false);
    expect(parseStatuspageSummary('[]').ok).toBe(false);
  });

  it('skips malformed entries instead of failing the whole page', () => {
    const body = variant((summary) => {
      (summary.components as unknown[]).push(null, { name: 42 }, 'nonsense');
    });
    expect(parse(body).components).toHaveLength(11);
  });
});
