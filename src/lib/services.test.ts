import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  apiUrl,
  applyFetch,
  backoff,
  DEFAULT_SERVICES,
  displayLevel,
  INITIAL_SERVICE,
  isDue,
  MAX_BACKOFF,
  POLL_INTERVAL,
  serviceAlert,
  serviceSubtitle,
  type FetchOutcome,
  type ServiceConfig,
  type ServiceState,
} from './services.ts';

/** Real: GitHub's summary.json as served on 2026-09-25, all operational. */
const GITHUB_OPERATIONAL = readFileSync(
  new URL('../../fixtures/statuspage/github-2026-09-25-operational.json', import.meta.url),
  'utf8',
);

/** SYNTHETIC: the real capture with Actions set to a documented outage value. */
function githubWith(status: string, incidents: unknown[] = []): string {
  const summary = JSON.parse(GITHUB_OPERATIONAL) as {
    components: { name: string; status: string }[];
    incidents: unknown[];
  };
  const actions = summary.components.find((component) => component.name === 'Actions');
  if (actions === undefined) throw new Error('No Actions component in the fixture');
  actions.status = status;
  summary.incidents = incidents;
  return JSON.stringify(summary);
}

const GITHUB: ServiceConfig = {
  id: 'github',
  name: 'GitHub',
  kind: 'statuspage',
  pageUrl: 'https://www.githubstatus.com',
};

const ok = (
  body: string,
  etag: string | null = null,
): Extract<FetchOutcome, { kind: 'response' }> => ({
  kind: 'response',
  status: 200,
  etag,
  url: apiUrl(GITHUB),
  body,
});
const failed: FetchOutcome = { kind: 'error', message: 'connection reset' };

function run(
  outcomes: readonly FetchOutcome[],
  from: ServiceState = INITIAL_SERVICE,
): ServiceState {
  return outcomes.reduce((state, outcome) => applyFetch(GITHUB, state, outcome, 0), from);
}

describe('DEFAULT_SERVICES', () => {
  it('only lists services whose status page is https', () => {
    for (const service of DEFAULT_SERVICES) expect(service.pageUrl).toMatch(/^https:\/\//);
  });
});

describe('apiUrl', () => {
  it('points at the summary behind the page, whatever the trailing slash', () => {
    expect(apiUrl(GITHUB)).toBe('https://www.githubstatus.com/api/v2/summary.json');
    expect(apiUrl({ ...GITHUB, pageUrl: 'https://www.githubstatus.com/' })).toBe(
      'https://www.githubstatus.com/api/v2/summary.json',
    );
  });
});

describe('applyFetch', () => {
  it('reads the real capture as operational and schedules the next poll', () => {
    const state = applyFetch(GITHUB, INITIAL_SERVICE, ok(GITHUB_OPERATIONAL, '"v1"'), 1000);
    expect(displayLevel(state)).toBe('operational');
    expect(state.etag).toBe('"v1"');
    expect(state.nextAt).toBe(1000 + POLL_INTERVAL);
  });

  it('keeps the reading on a 304, which is what sending the ETag earns', () => {
    const first = run([ok(GITHUB_OPERATIONAL, '"v1"')]);
    const state = run([{ kind: 'response', status: 304, etag: null, url: '', body: '' }], first);
    expect(state.snapshot).toBe(first.snapshot);
    expect(state.failures).toBe(0);
  });

  it('keeps the last reading through one failure, then goes unknown', () => {
    expect(displayLevel(run([ok(GITHUB_OPERATIONAL), failed]))).toBe('operational');
    expect(displayLevel(run([ok(GITHUB_OPERATIONAL), failed, failed]))).toBe('unknown');
  });

  it('treats an error page, a non-200 or a login page as a failure, not as data', () => {
    const htmlPage = ok('<!doctype html><title>Sign in</title>');
    expect(run([htmlPage]).failures).toBe(1);
    expect(run([{ ...ok(GITHUB_OPERATIONAL), status: 503 }]).failures).toBe(1);
  });

  it('is unknown, not green, when the very first fetch fails', () => {
    expect(displayLevel(run([failed]))).toBe('unknown');
  });

  it('is null (checking) before anything has come back', () => {
    expect(displayLevel(INITIAL_SERVICE)).toBeNull();
  });
});

describe('isDue and backoff', () => {
  it('is due immediately at first', () => {
    expect(isDue(INITIAL_SERVICE, 0)).toBe(true);
  });

  it('backs off by doubling, capped', () => {
    expect(backoff(1)).toBe(POLL_INTERVAL);
    expect(backoff(2)).toBe(2 * POLL_INTERVAL);
    expect(backoff(3)).toBe(4 * POLL_INTERVAL);
    expect(backoff(50)).toBe(MAX_BACKOFF);
  });

  it('schedules a failing service by the backoff', () => {
    const state = applyFetch(GITHUB, run([failed]), failed, 10_000);
    expect(state.nextAt).toBe(10_000 + backoff(2));
  });
});

describe('serviceAlert (synthetic outage variants of the real capture)', () => {
  it('says nothing while the service is fine', () => {
    expect(serviceAlert(GITHUB, run([ok(GITHUB_OPERATIONAL)]))).toBeNull();
  });

  it('names the level, says what is affected, and links the status page', () => {
    const alert = serviceAlert(GITHUB, run([ok(githubWith('major_outage'))]));
    expect(alert).toEqual({
      key: 'service:github:major',
      level: 'major',
      title: 'GitHub: major outage',
      detail: 'Actions',
      link: { label: 'View status page', url: 'https://www.githubstatus.com' },
    });
  });

  it('prefers the incident name, and keys on the incident so a new one pops again', () => {
    const body = githubWith('partial_outage', [
      { id: 'inc1', name: 'Delayed Actions jobs', impact: 'minor' },
    ]);
    const alert = serviceAlert(GITHUB, run([ok(body)]));
    expect(alert?.detail).toBe('Delayed Actions jobs');
    expect(alert?.key).toBe('service:github:partial:inc1');
  });

  it('does not pop for maintenance, or for a page it cannot read', () => {
    expect(serviceAlert(GITHUB, run([ok(githubWith('under_maintenance'))]))).toBeNull();
    expect(serviceAlert(GITHUB, run([ok(GITHUB_OPERATIONAL), failed, failed]))).toBeNull();
  });
});

describe('serviceSubtitle', () => {
  it('says nothing for a healthy service', () => {
    expect(serviceSubtitle(run([ok(GITHUB_OPERATIONAL)]), true)).toBeNull();
  });

  it('explains why a service is unknown', () => {
    expect(serviceSubtitle(run([failed, failed]), true)).toBe('connection reset');
  });

  it('stays quiet while offline, where the Internet row already explains it', () => {
    expect(serviceSubtitle(run([failed, failed]), false)).toBeNull();
  });
});
