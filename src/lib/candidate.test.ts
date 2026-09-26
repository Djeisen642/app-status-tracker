import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { describeFound, findExisting, judgeCandidate, normalizeCandidate } from './candidate.ts';
import { DEFAULT_SERVICES, type FetchOutcome } from './services.ts';

/** Real captures, as served on 2026-09-25. */
const GITHUB = readFileSync(
  new URL('../../fixtures/statuspage/github-2026-09-25-operational.json', import.meta.url),
  'utf8',
);
const CURSOR = readFileSync(
  new URL('../../fixtures/statuspage/cursor-2026-09-25-incident.json', import.meta.url),
  'utf8',
);

function answered(url: string, body: string, status = 200): FetchOutcome {
  return { kind: 'response', status, etag: null, url, body };
}

function origin(input: string): string {
  const result = normalizeCandidate(input);
  if (!result.ok) throw new Error(result.error);
  return result.origin;
}

describe('normalizeCandidate', () => {
  it('accepts a bare host, a full URL, or a link deep into the page', () => {
    expect(origin('status.cursor.com')).toBe('https://status.cursor.com');
    expect(origin('https://www.githubstatus.com/')).toBe('https://www.githubstatus.com');
    expect(origin('  https://www.githubstatus.com/incidents/abc123?x=1#y ')).toBe(
      'https://www.githubstatus.com',
    );
  });

  it('upgrades http to https and ignores case in the host', () => {
    expect(origin('http://Status.Cursor.com')).toBe('https://status.cursor.com');
  });

  it('keeps an explicit non-default port', () => {
    expect(origin('https://status.example.com:8443')).toBe('https://status.example.com:8443');
  });

  it('refuses empty input, non-web schemes and embedded credentials', () => {
    expect(normalizeCandidate('   ').ok).toBe(false);
    expect(normalizeCandidate('file:///etc/passwd').ok).toBe(false);
    expect(normalizeCandidate('ftp://status.example.com').ok).toBe(false);
    expect(normalizeCandidate('https://user:secret@status.example.com').ok).toBe(false);
  });

  it('refuses hosts that are not on the public internet', () => {
    expect(normalizeCandidate('localhost:3000').ok).toBe(false);
    expect(normalizeCandidate('intranet').ok).toBe(false);
  });

  it('says why, in words', () => {
    const result = normalizeCandidate('not a url at all');
    expect(result).toEqual({ ok: false, error: expect.stringContaining('web address') as string });
  });
});

describe('judgeCandidate, against real captures', () => {
  it('accepts Cursor, taking its name from the page and its current level', () => {
    const verdict = judgeCandidate(
      'https://status.cursor.com',
      answered('https://status.cursor.com/api/v2/summary.json', CURSOR),
      [],
    );
    expect(verdict).toEqual({
      ok: true,
      service: {
        id: 'status.cursor.com',
        name: 'Cursor',
        kind: 'statuspage',
        pageUrl: 'https://status.cursor.com',
      },
      level: 'degraded',
      componentCount: 8,
    });
  });

  it('follows a moved page to where it landed', () => {
    const verdict = judgeCandidate(
      'https://status.github.com',
      answered('https://www.githubstatus.com/api/v2/summary.json', GITHUB),
      [],
    );
    expect(verdict.ok && verdict.service.pageUrl).toBe('https://www.githubstatus.com');
    expect(verdict.ok && verdict.service.name).toBe('GitHub');
  });

  it('refuses a page already being watched, even reached through a redirect', () => {
    const verdict = judgeCandidate(
      'https://status.github.com',
      answered('https://www.githubstatus.com/api/v2/summary.json', GITHUB),
      DEFAULT_SERVICES,
    );
    expect(verdict).toEqual({
      ok: false,
      error: expect.stringContaining('already watching') as string,
    });
  });

  it('describes what it found', () => {
    const verdict = judgeCandidate(
      'https://status.cursor.com',
      answered('https://status.cursor.com/api/v2/summary.json', CURSOR),
      [],
    );
    if (!verdict.ok) throw new Error(verdict.error);
    expect(describeFound(verdict)).toBe('Added Cursor: 8 components, currently degraded.');
  });
});

describe('judgeCandidate, on sites it cannot watch', () => {
  const site = 'https://example.com';
  const api = `${site}/api/v2/summary.json`;

  it('refuses a site with no Statuspage API, and says what is supported', () => {
    const verdict = judgeCandidate(site, answered(api, '<html>Not found</html>', 404), []);
    expect(verdict).toEqual({
      ok: false,
      error: expect.stringContaining('Atlassian Statuspage') as string,
    });
  });

  it('refuses a 200 that is not a status summary (a homepage, a login page)', () => {
    const verdict = judgeCandidate(
      site,
      answered(api, '<!doctype html><title>Welcome</title>'),
      [],
    );
    expect(verdict.ok).toBe(false);
  });

  it('refuses JSON that is not a Statuspage summary', () => {
    expect(judgeCandidate(site, answered(api, '{"status":"ok"}'), []).ok).toBe(false);
  });

  it('says it could not reach the site, rather than calling it unsupported', () => {
    const verdict = judgeCandidate(site, { kind: 'error', message: 'dns error' }, []);
    expect(verdict).toEqual({
      ok: false,
      error: expect.stringContaining('Couldn’t reach') as string,
    });
  });

  it('treats a server error as try-again, not as unsupported', () => {
    const verdict = judgeCandidate(site, answered(api, 'oops', 503), []);
    expect(verdict).toEqual({
      ok: false,
      error: expect.stringContaining('answered 503') as string,
    });
  });
});

describe('findExisting', () => {
  it('matches by origin, ignoring a trailing slash', () => {
    expect(findExisting('https://status.cursor.com', DEFAULT_SERVICES)?.id).toBe('cursor');
    expect(
      findExisting('https://www.githubstatus.com', [
        { ...DEFAULT_SERVICES[0], pageUrl: 'https://www.githubstatus.com/' },
      ])?.name,
    ).toBe('GitHub');
  });
});
