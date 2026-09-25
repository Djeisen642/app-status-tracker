import { describe, expect, it } from 'vitest';

import { isWorse, LEVELS, worstLevel } from './status.ts';

describe('worstLevel', () => {
  it('is operational for nothing at all', () => {
    expect(worstLevel([])).toBe('operational');
  });

  it('picks the worst regardless of order', () => {
    expect(worstLevel(['major', 'operational', 'degraded'])).toBe('major');
    expect(worstLevel(['degraded', 'major', 'operational'])).toBe('major');
  });

  it('ranks unknown above every real outage, because blind is worse than red', () => {
    expect(worstLevel(['major', 'unknown'])).toBe('unknown');
  });

  it('accepts any iterable, not only arrays', () => {
    expect(worstLevel(new Set(['maintenance', 'operational'] as const))).toBe('maintenance');
  });
});

describe('isWorse', () => {
  it('is strict', () => {
    for (const level of LEVELS) expect(isWorse(level, level)).toBe(false);
  });

  it('orders maintenance between operational and degraded', () => {
    expect(isWorse('maintenance', 'operational')).toBe(true);
    expect(isWorse('degraded', 'maintenance')).toBe(true);
  });
});
