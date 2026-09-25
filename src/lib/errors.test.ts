import { describe, expect, it } from 'vitest';

import { describeError } from './errors.ts';

describe('describeError', () => {
  it('uses an Error message', () => {
    expect(describeError(new Error('vault write failed'))).toBe('vault write failed');
  });

  it('passes a string through, which is what Rust commands reject with', () => {
    expect(describeError('permission denied')).toBe('permission denied');
  });

  it('serializes a plain object', () => {
    expect(describeError({ code: 42 })).toBe('{"code":42}');
  });

  it('falls back for an empty object rather than showing "{}"', () => {
    expect(describeError({})).toBe('An unknown error occurred.');
  });

  it('falls back for a circular structure instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular)).toBe('An unknown error occurred.');
  });

  it('falls back for null and undefined', () => {
    expect(describeError(null)).toBe('An unknown error occurred.');
    expect(describeError(undefined)).toBe('An unknown error occurred.');
  });
});
