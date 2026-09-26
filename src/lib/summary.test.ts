import { describe, expect, it } from 'vitest';

import { headline } from './summary.ts';

describe('headline', () => {
  it('says everything is fine in as many words', () => {
    expect(
      headline('online', [
        { name: 'GitHub', level: 'operational' },
        { name: 'Cursor', level: 'operational' },
      ]),
    ).toEqual({ tone: 'good', title: 'All systems normal', detail: '2 services watched' });
  });

  it('puts the connection ahead of every service', () => {
    const services = [{ name: 'GitHub', level: 'major' as const }];
    expect(headline('offline', services).title).toBe('You’re offline');
    expect(headline('portal', services).title).toBe('Wi-Fi sign-in needed');
  });

  it('names the worst service, and counts the rest', () => {
    const result = headline('online', [
      { name: 'Cursor', level: 'degraded' },
      { name: 'GitHub', level: 'major' },
      { name: 'Linear', level: 'operational' },
    ]);
    expect(result).toEqual({
      tone: 'bad',
      title: 'GitHub is having a major outage',
      detail: '3 services watched · 1 more with issues',
    });
  });

  it('is amber, not red, for degraded and for maintenance', () => {
    expect(headline('online', [{ name: 'Cursor', level: 'degraded' }])).toMatchObject({
      tone: 'warn',
      title: 'Cursor is degraded',
    });
    expect(headline('online', [{ name: 'GitHub', level: 'maintenance' }]).tone).toBe('warn');
  });

  it('owns up to being blind rather than claiming all clear', () => {
    expect(
      headline('online', [
        { name: 'GitHub', level: 'unknown' },
        { name: 'Cursor', level: 'operational' },
      ]),
    ).toMatchObject({ tone: 'idle', title: 'Can’t read GitHub’s status' });
  });

  it('does not say all clear until every service has reported', () => {
    expect(
      headline('online', [
        { name: 'GitHub', level: 'operational' },
        { name: 'Cursor', level: null },
      ]).title,
    ).toBe('Checking…');
  });

  it('reports a problem even while others are still checking', () => {
    expect(
      headline('online', [
        { name: 'GitHub', level: 'major' },
        { name: 'Cursor', level: null },
      ]).tone,
    ).toBe('bad');
  });

  it('has something to say with nothing to watch', () => {
    expect(headline('online', []).title).toBe('Nothing to watch');
  });

  it('is checking while the connection is', () => {
    expect(headline('checking', [{ name: 'GitHub', level: null }]).tone).toBe('idle');
  });

  it('headlines a real outage over a service it cannot read', () => {
    expect(
      headline('online', [
        { name: 'Linear', level: 'unknown' },
        { name: 'GitHub', level: 'major' },
      ]),
    ).toMatchObject({
      tone: 'bad',
      title: 'GitHub is having a major outage',
      detail: '2 services watched · 1 more with issues',
    });
  });

  it('pluralizes a lone service', () => {
    expect(headline('online', [{ name: 'GitHub', level: 'operational' }]).detail).toBe(
      '1 service watched',
    );
  });
});
