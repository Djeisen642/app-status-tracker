import { describe, expect, it } from 'vitest';

import { formatTrayStatus } from './tray.ts';

describe('formatTrayStatus', () => {
  it('says so when nothing is being watched', () => {
    expect(formatTrayStatus([])).toBe('No services yet');
  });

  it('collapses an all-clear to a count', () => {
    expect(
      formatTrayStatus([
        { name: 'GitHub', level: 'operational' },
        { name: 'Cursor', level: 'operational' },
      ]),
    ).toBe('All 2 operational');
  });

  it('names a lone service rather than saying "All 1"', () => {
    expect(formatTrayStatus([{ name: 'GitHub', level: 'operational' }])).toBe('GitHub operational');
  });

  it('names the problems, not the healthy services', () => {
    expect(
      formatTrayStatus([
        { name: 'GitHub', level: 'operational' },
        { name: 'Cursor', level: 'degraded' },
      ]),
    ).toBe('Cursor: degraded');
  });

  it('puts the worst first and keeps configured order on a tie', () => {
    expect(
      formatTrayStatus([
        { name: 'A', level: 'degraded' },
        { name: 'B', level: 'major' },
        { name: 'C', level: 'degraded' },
      ]),
    ).toBe('B: major outage · A: degraded · +1 more');
  });

  it('reports a blind service as unknown, never as fine', () => {
    expect(formatTrayStatus([{ name: 'GitHub', level: 'unknown' }])).toBe('GitHub: unknown');
  });

  it('counts only problems in the overflow', () => {
    expect(
      formatTrayStatus([
        { name: 'A', level: 'major' },
        { name: 'B', level: 'operational' },
        { name: 'C', level: 'partial' },
      ]),
    ).toBe('A: major outage · C: partial outage');
  });

  it('puts no connection ahead of every service', () => {
    expect(formatTrayStatus([{ name: 'GitHub', level: 'major' }], 'offline')).toBe(
      'Offline: no internet connection',
    );
    expect(formatTrayStatus([], 'portal')).toBe('Offline: Wi-Fi sign-in required');
  });

  it('says nothing about the connection while it is fine or still being checked', () => {
    expect(formatTrayStatus([], 'checking')).toBe('No services yet');
    expect(formatTrayStatus([], 'online')).toBe('No services yet');
  });
});
