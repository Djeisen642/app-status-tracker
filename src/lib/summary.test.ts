import { describe, expect, it } from 'vitest';

import { headline, toneOf } from './summary.ts';

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

  it('says what is wrong instead of how many services there are', () => {
    expect(
      headline('online', [
        { name: 'Cursor', level: 'degraded', detail: 'Elevated errors affecting Anthropic models' },
        { name: 'GitHub', level: 'operational' },
        { name: 'Phaxio', level: 'operational' },
      ]),
    ).toEqual({
      tone: 'warn',
      title: 'Cursor is degraded',
      detail: 'Elevated errors affecting Anthropic models',
    });
  });

  it('puts the worst service’s detail first, then counts the rest', () => {
    expect(
      headline('online', [
        { name: 'Cursor', level: 'degraded', detail: 'Elevated errors' },
        { name: 'GitHub', level: 'major', detail: 'Git operations are failing' },
      ]).detail,
    ).toBe('Git operations are failing · 1 more with issues');
  });

  it('says why it cannot read a service, in the service’s own words', () => {
    expect(
      headline('online', [{ name: 'GitHub', level: 'unknown', detail: 'connection reset' }]),
    ).toMatchObject({ title: 'Can’t read GitHub’s status', detail: 'connection reset' });
  });

  it('falls back to the count when a problem has nothing more to say', () => {
    expect(headline('online', [{ name: 'Cursor', level: 'degraded', detail: null }]).detail).toBe(
      '1 service watched',
    );
    expect(headline('online', [{ name: 'Cursor', level: 'degraded', detail: '' }]).detail).toBe(
      '1 service watched',
    );
  });

  it('does not let a healthy service’s detail into the all-clear', () => {
    expect(
      headline('online', [{ name: 'GitHub', level: 'operational', detail: 'left over' }]).detail,
    ).toBe('1 service watched');
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

describe('toneOf', () => {
  it('is red for outages, amber for degraded and maintenance, grey for blind', () => {
    expect(toneOf('major')).toBe('bad');
    expect(toneOf('partial')).toBe('bad');
    expect(toneOf('degraded')).toBe('warn');
    expect(toneOf('maintenance')).toBe('warn');
    expect(toneOf('unknown')).toBe('idle');
    expect(toneOf('operational')).toBe('good');
  });
});
