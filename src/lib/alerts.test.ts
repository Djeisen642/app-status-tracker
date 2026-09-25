import { describe, expect, it } from 'vitest';

import {
  acknowledge,
  connectivityAlert,
  dismiss,
  EMPTY_POPUP,
  reconcile,
  type Alert,
  type PopupState,
} from './alerts.ts';

const PROBE = 'http://probe.test/generate_204';

function alert(key: string, detail = ''): Alert {
  return { key, level: 'major', title: key, detail, link: null };
}

/** Run several rounds of checks through `reconcile`, keeping only the state. */
function rounds(...active: (readonly Alert[])[]): PopupState {
  return active.reduce<PopupState>((state, round) => reconcile(state, round).state, EMPTY_POPUP);
}

describe('connectivityAlert', () => {
  it('says nothing while the connection is fine or still being checked', () => {
    expect(connectivityAlert('online', null, PROBE)).toBeNull();
    expect(connectivityAlert('checking', null, PROBE)).toBeNull();
  });

  it('has no link when offline, because there is nothing to open', () => {
    expect(connectivityAlert('offline', null, PROBE)?.link).toBeNull();
  });

  it('links a captive portal to where it redirected', () => {
    expect(connectivityAlert('portal', 'http://login.hotel/', PROBE)?.link?.url).toBe(
      'http://login.hotel/',
    );
  });

  it('falls back to the probe URL, which a browser will be redirected from too', () => {
    expect(connectivityAlert('portal', null, PROBE)?.link?.url).toBe(PROBE);
  });
});

describe('reconcile', () => {
  it('raises the popup when something goes bad', () => {
    const result = reconcile(EMPTY_POPUP, [alert('github:major')]);
    expect(result.raised).toBe(true);
    expect(result.state.shown.map((a) => a.key)).toEqual(['github:major']);
  });

  it('does not raise again while the same thing stays bad', () => {
    const state = rounds([alert('github:major')]);
    expect(reconcile(state, [alert('github:major')]).raised).toBe(false);
  });

  it('updates a shown alert in place as its detail moves on', () => {
    const state = rounds(
      [alert('github:major', 'Investigating')],
      [alert('github:major', 'Identified')],
    );
    expect(state.shown).toEqual([alert('github:major', 'Identified')]);
  });

  it('clears an alert on its own once the check recovers', () => {
    const state = rounds([alert('github:major')], []);
    expect(state.shown).toEqual([]);
  });

  it('raises for a worse level, which is a new key', () => {
    const state = rounds([alert('github:degraded')]);
    const result = reconcile(state, [alert('github:major')]);
    expect(result.raised).toBe(true);
    expect(result.state.shown.map((a) => a.key)).toEqual(['github:major']);
  });

  it('keeps arrival order and appends newcomers', () => {
    const state = rounds([alert('a')], [alert('b'), alert('a')]);
    expect(state.shown.map((a) => a.key)).toEqual(['a', 'b']);
  });

  it('raises only for the newcomer when one more thing breaks', () => {
    const state = rounds([alert('a')]);
    const result = reconcile(state, [alert('a'), alert('b')]);
    expect(result.raised).toBe(true);
  });
});

describe('dismiss', () => {
  it('keeps a dismissed alert away while it is still active', () => {
    const closed = dismiss(rounds([alert('a')]), 'a');
    const result = reconcile(closed, [alert('a')]);
    expect(result.raised).toBe(false);
    expect(result.state.shown).toEqual([]);
  });

  it('lets the same kind of outage pop again after a recovery', () => {
    const closed = dismiss(rounds([alert('a')]), 'a');
    const recovered = reconcile(closed, []).state;
    expect(reconcile(recovered, [alert('a')]).raised).toBe(true);
  });

  it('leaves the others on screen', () => {
    const state = dismiss(rounds([alert('a'), alert('b')]), 'a');
    expect(state.shown.map((a) => a.key)).toEqual(['b']);
  });

  it('ignores a key that is not shown', () => {
    const state = rounds([alert('a')]);
    expect(dismiss(state, 'nope')).toBe(state);
  });
});

describe('acknowledge', () => {
  it('clears the popup without letting the same alerts pop again', () => {
    const seen = acknowledge(rounds([alert('a')]));
    expect(seen.shown).toEqual([]);
    expect(reconcile(seen, [alert('a')]).raised).toBe(false);
  });
});
