import { describe, expect, it } from 'vitest';

import { httpsOrigin, isRecord, originOf } from './untrusted.ts';

describe('isRecord', () => {
  it('accepts a plain object and nothing else', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [null, undefined, [], 'x', 1, true]) expect(isRecord(value)).toBe(false);
  });
});

describe('originOf', () => {
  it('reduces a URL to its origin, ignoring path and trailing slash', () => {
    expect(originOf('https://www.githubstatus.com/')).toBe('https://www.githubstatus.com');
    expect(originOf('https://status.example.com:8443/a?b#c')).toBe(
      'https://status.example.com:8443',
    );
  });

  it('is null for something that is not a URL', () => {
    expect(originOf('not a url')).toBeNull();
  });
});

describe('httpsOrigin', () => {
  it('is the origin of an https URL', () => {
    expect(httpsOrigin('https://status.cursor.com/api/v2/summary.json')).toBe(
      'https://status.cursor.com',
    );
  });

  it('is null for http, other schemes, and garbage', () => {
    expect(httpsOrigin('http://status.cursor.com')).toBeNull();
    expect(httpsOrigin('javascript:alert(1)')).toBeNull();
    expect(httpsOrigin('nonsense')).toBeNull();
  });
});
