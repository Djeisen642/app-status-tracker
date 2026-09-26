import { describe, expect, it } from 'vitest';

import { withJitter } from './jitter.ts';

describe('withJitter', () => {
  it('never shortens the base delay', () => {
    expect(withJitter(30_000, 5_000, () => 0)).toBe(30_000);
  });

  it('adds up to, but never the full, spread', () => {
    expect(withJitter(30_000, 5_000, () => 0.999999)).toBe(34_999);
  });

  it('scales with whatever it is given for randomness', () => {
    expect(withJitter(60_000, 10_000, () => 0.5)).toBe(65_000);
  });
});
