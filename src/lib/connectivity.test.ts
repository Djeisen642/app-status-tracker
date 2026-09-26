import { describe, expect, it } from 'vitest';

import {
  combineVerdicts,
  INITIAL_CONNECTIVITY,
  judgeProbe,
  nextCheckDelay,
  observe,
  OFFLINE_AFTER,
  PROBES,
  portalLocation,
  type ConnectivityState,
  type Probe,
  type ProbeVerdict,
} from './connectivity.ts';

const NO_CONTENT: Probe = { name: 'A', url: 'http://a.test/generate_204', expectStatus: 204 };
const FIXED_BODY: Probe = {
  name: 'B',
  url: 'http://b.test/check.txt',
  expectStatus: 200,
  expectBody: 'All good',
};

describe('PROBES', () => {
  it('are plain http, because a portal can only intercept an unencrypted request', () => {
    for (const probe of PROBES) expect(probe.url).toMatch(/^http:\/\//);
  });

  it('come from more than one provider', () => {
    const hosts = new Set(PROBES.map((probe) => new URL(probe.url).hostname));
    expect(hosts.size).toBeGreaterThan(1);
  });
});

describe('judgeProbe', () => {
  it('accepts the expected status', () => {
    expect(
      judgeProbe(NO_CONTENT, { kind: 'response', status: 204, location: null, body: '' }),
    ).toBe('ok');
  });

  it('reads a redirect as a captive portal, not as offline', () => {
    expect(
      judgeProbe(NO_CONTENT, {
        kind: 'response',
        status: 302,
        location: 'http://portal.hotel/login',
        body: '',
      }),
    ).toBe('portal');
  });

  it('reads a login page served where a 204 belonged as a portal', () => {
    expect(
      judgeProbe(NO_CONTENT, {
        kind: 'response',
        status: 200,
        location: null,
        body: '<html>Sign in</html>',
      }),
    ).toBe('portal');
  });

  it('checks a fixed body, ignoring surrounding whitespace', () => {
    const answer = (body: string) =>
      judgeProbe(FIXED_BODY, { kind: 'response', status: 200, location: null, body });
    expect(answer('All good\n')).toBe('ok');
    expect(answer('<html>Welcome to Airport Wi-Fi</html>')).toBe('portal');
  });

  it('reads a failed request as failed', () => {
    expect(judgeProbe(NO_CONTENT, { kind: 'error', message: 'dns error' })).toBe('failed');
  });

  it('accepts an opaque browser response as reachable', () => {
    expect(judgeProbe(NO_CONTENT, { kind: 'opaque' })).toBe('ok');
  });
});

describe('combineVerdicts', () => {
  it('is online when any provider answers correctly', () => {
    expect(combineVerdicts(['failed', 'ok'])).toBe('ok');
    expect(combineVerdicts(['portal', 'ok'])).toBe('ok');
  });

  it('prefers the actionable portal over a plain failure', () => {
    expect(combineVerdicts(['failed', 'portal'])).toBe('portal');
  });

  it('fails only when every provider fails', () => {
    expect(combineVerdicts(['failed', 'failed'])).toBe('failed');
  });

  it('fails on no probes at all rather than claiming online', () => {
    expect(combineVerdicts([])).toBe('failed');
  });
});

function run(verdicts: readonly ProbeVerdict[], from = INITIAL_CONNECTIVITY): ConnectivityState {
  return verdicts.reduce((state, verdict) => observe(state, verdict), from);
}

describe('observe', () => {
  it('goes online on the first success', () => {
    expect(run(['ok']).status).toBe('online');
  });

  it(`waits for ${String(OFFLINE_AFTER)} failed rounds before saying offline`, () => {
    expect(run(['ok', 'failed']).status).toBe('online');
    expect(run(['ok', 'failed', 'failed']).status).toBe('offline');
  });

  it('stays checking, not online, when the very first round fails', () => {
    expect(run(['failed']).status).toBe('checking');
  });

  it('recovers on a single success', () => {
    expect(run(['failed', 'failed', 'ok'])).toEqual({ status: 'online', failures: 0 });
  });

  it('forgets an isolated failure once a round succeeds', () => {
    expect(run(['ok', 'failed', 'ok', 'failed']).status).toBe('online');
  });

  it('shows a portal immediately', () => {
    expect(run(['ok', 'portal']).status).toBe('portal');
  });

  it('trusts the browser when it says there is no network at all', () => {
    const state = observe(run(['ok']), 'ok', true);
    expect(state.status).toBe('offline');
    // …and a later failure keeps it offline rather than restarting the count.
    expect(observe(state, 'failed').status).toBe('offline');
  });
});

describe('nextCheckDelay', () => {
  it('checks quickly while in doubt', () => {
    expect(nextCheckDelay(INITIAL_CONNECTIVITY)).toBe(5000);
    expect(nextCheckDelay(run(['ok', 'failed']))).toBe(5000);
  });

  it('relaxes once online', () => {
    expect(nextCheckDelay(run(['ok']))).toBe(30_000);
  });

  it('keeps checking while offline or behind a portal, so recovery is prompt', () => {
    expect(nextCheckDelay(run(['failed', 'failed']))).toBe(10_000);
    expect(nextCheckDelay(run(['portal']))).toBe(10_000);
  });
});

describe('portalLocation', () => {
  const redirect = (location: string | null) => ({
    probe: NO_CONTENT,
    outcome: { kind: 'response' as const, status: 302, location, body: '' },
  });

  it('returns where the portal redirected', () => {
    expect(portalLocation([redirect('http://login.hotel/start')])).toBe('http://login.hotel/start');
  });

  it('resolves a relative redirect against the probe', () => {
    expect(portalLocation([redirect('/login')])).toBe('http://a.test/login');
  });

  it('drops anything that is not http(s)', () => {
    expect(portalLocation([redirect('javascript:alert(1)')])).toBeNull();
  });

  it('skips probes that were not redirected and takes the first that was', () => {
    expect(
      portalLocation([
        { probe: NO_CONTENT, outcome: { kind: 'error', message: 'timeout' } },
        redirect(null),
        redirect('https://portal.example/'),
      ]),
    ).toBe('https://portal.example/');
  });
});
