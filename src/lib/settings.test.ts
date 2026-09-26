import { describe, expect, it } from 'vitest';

import type { ServiceConfig } from './services.ts';
import {
  DEFAULT_SETTINGS,
  parseSettings,
  readSettings,
  serializeSettings,
  type Settings,
} from './settings.ts';

const EXAMPLE: ServiceConfig = {
  id: 'status.example.com',
  name: 'Example',
  kind: 'statuspage',
  pageUrl: 'https://status.example.com',
};

const only = (services: readonly ServiceConfig[]): Settings => ({
  services,
  others: [],
  extra: {},
});

describe('readSettings', () => {
  it('starts a first launch on the built-in services, free to save', () => {
    expect(readSettings(null)).toEqual({ settings: DEFAULT_SETTINGS, writable: true });
  });

  it('round-trips what it writes', () => {
    expect(parseSettings(serializeSettings(only([EXAMPLE])))).toEqual(only([EXAMPLE]));
  });

  it('keeps an empty list: removing everything is a choice', () => {
    expect(parseSettings('{"services":[]}').services).toEqual([]);
  });

  it('runs on the defaults when the file is not settings at all, but refuses to save over it', () => {
    for (const text of ['not json', '[]', '{"services":"github"}', '{}']) {
      expect(readSettings(text)).toEqual({ settings: DEFAULT_SETTINGS, writable: false });
    }
  });

  it('uses the entries it understands and keeps the rest aside', () => {
    const futureKind = { ...EXAMPLE, id: 'other-kind', kind: 'instatus' };
    const plainHttp = { ...EXAMPLE, id: 'plain', pageUrl: 'http://status.example.org' };
    const text = JSON.stringify({ services: [EXAMPLE, plainHttp, futureKind, null, 'github'] });

    const { settings, writable } = readSettings(text);
    expect(writable).toBe(true);
    expect(settings.services).toEqual([EXAMPLE]);
    expect(settings.others).toEqual([plainHttp, futureKind, null, 'github']);
  });

  it('keeps the first of two entries with the same id, and the second aside', () => {
    const second = { ...EXAMPLE, name: 'Second' };
    const { settings } = readSettings(JSON.stringify({ services: [EXAMPLE, second] }));
    expect(settings.services.map((service) => service.name)).toEqual(['Example']);
    expect(settings.others).toEqual([second]);
  });

  it('keeps a component watch list, and only its strings', () => {
    const text = JSON.stringify({ services: [{ ...EXAMPLE, components: ['API', 7, 'Web'] }] });
    expect(parseSettings(text).services[0]?.components).toEqual(['API', 'Web']);
  });
});

describe('serializeSettings (regression: a save must not delete what it did not understand)', () => {
  it('writes back entries this build could not read, untouched', () => {
    const future = { id: 'x', name: 'Future', kind: 'instatus', pageUrl: 'https://x.example' };
    const loaded = parseSettings(JSON.stringify({ services: [EXAMPLE, future] }));

    // The user removes Example; the entry this build can't read must survive.
    const saved = JSON.parse(serializeSettings({ ...loaded, services: [] })) as {
      services: unknown[];
    };
    expect(saved.services).toEqual([future]);
  });

  it('writes back top-level keys it does not know', () => {
    const loaded = parseSettings(JSON.stringify({ services: [], theme: 'dark', version: 3 }));
    const saved = JSON.parse(serializeSettings(loaded)) as Record<string, unknown>;
    expect(saved).toEqual({ theme: 'dark', version: 3, services: [] });
  });
});
