import { describe, expect, it } from 'vitest';

import { formatBuildInfo } from './build-info.ts';

describe('formatBuildInfo', () => {
  it('names the version, commit and build date', () => {
    expect(
      formatBuildInfo({ version: '0.2.0', commit: 'a1b2c3d4', builtAt: '2026-09-26T10:30:00Z' }),
    ).toBe('0.2.0 (a1b2c3d4) · built Sep 26, 2026');
  });

  it('drops the commit outside a git checkout rather than showing null', () => {
    expect(
      formatBuildInfo({ version: '0.2.0', commit: null, builtAt: '2026-09-26T10:30:00Z' }),
    ).toBe('0.2.0 · built Sep 26, 2026');
  });

  it('falls back to the raw string for a date it cannot parse', () => {
    expect(formatBuildInfo({ version: '0.2.0', commit: null, builtAt: 'not-a-date' })).toBe(
      '0.2.0 · built not-a-date',
    );
  });
});
