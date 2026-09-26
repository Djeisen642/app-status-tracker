import { describe, expect, it } from 'vitest';

import type { ServiceConfig } from './services.ts';
import { DEFAULT_SETTINGS, parseSettings, serializeSettings } from './settings.ts';

const EXAMPLE: ServiceConfig = {
  id: 'status.example.com',
  name: 'Example',
  kind: 'statuspage',
  pageUrl: 'https://status.example.com',
};

describe('parseSettings', () => {
  it('starts a first launch on the built-in services', () => {
    expect(parseSettings(null)).toBe(DEFAULT_SETTINGS);
  });

  it('round-trips what it writes', () => {
    const settings = { services: [EXAMPLE] };
    expect(parseSettings(serializeSettings(settings))).toEqual(settings);
  });

  it('keeps an empty list: removing everything is a choice', () => {
    expect(parseSettings('{"services":[]}')).toEqual({ services: [] });
  });

  it('falls back to the defaults when the file is not settings at all', () => {
    expect(parseSettings('not json')).toBe(DEFAULT_SETTINGS);
    expect(parseSettings('[]')).toBe(DEFAULT_SETTINGS);
    expect(parseSettings('{"services":"github"}')).toBe(DEFAULT_SETTINGS);
  });

  it('drops broken entries and keeps the good ones', () => {
    const text = JSON.stringify({
      services: [
        EXAMPLE,
        { ...EXAMPLE, id: 'plain', pageUrl: 'http://status.example.org' },
        { ...EXAMPLE, id: 'other-kind', kind: 'rss' },
        { ...EXAMPLE, id: '' },
        null,
        'github',
      ],
    });
    expect(parseSettings(text).services).toEqual([EXAMPLE]);
  });

  it('keeps the first of two entries with the same id', () => {
    const text = JSON.stringify({ services: [EXAMPLE, { ...EXAMPLE, name: 'Second' }] });
    expect(parseSettings(text).services.map((service) => service.name)).toEqual(['Example']);
  });

  it('keeps a component watch list, and only its strings', () => {
    const text = JSON.stringify({ services: [{ ...EXAMPLE, components: ['API', 7, 'Web'] }] });
    expect(parseSettings(text).services[0]?.components).toEqual(['API', 'Web']);
  });
});
