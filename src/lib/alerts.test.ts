import { describe, expect, it } from 'vitest';

import {
  acknowledge,
  connectivityAlert,
  dismiss,
  EMPTY_POPUP,
  escalates,
  reconcile,
  visible,
  type Alert,
  type PopupState,
} from './alerts.ts';
import type { Level } from './status.ts';

const PROBE = 'http://probe.test/generate_204';

function alert(
  group: string,
  level: Level = 'major',
  incidents: readonly string[] = [],
  detail = '',
): Alert {
  return {
    key: [group, level, ...incidents].join(':'),
    group,
    level,
    incidents,
    title: group,
    detail,
    link: null,
  };
}

/** Run several rounds through `reconcile`, keeping only the state. */
function rounds(...active: (readonly Alert[])[]): PopupState {
  return active.reduce<PopupState>((state, round) => reconcile(state, round).state, EMPTY_POPUP);
}

/** A resolved card for `group`, as `episodes.ts` would build one. */
function resolvedCard(group: string, at = 1): Alert {
  return {
    key: `resolved:${group}:${String(at)}`,
    group,
    level: 'operational',
    incidents: [],
    title: `${group}: resolved`,
    detail: '',
    link: null,
  };
}

const shownGroups = (state: PopupState) => state.shown.map((a) => a.group);

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

  it('puts offline and portal in one group, so easing from one to the other is not news', () => {
    const offline = connectivityAlert('offline', null, PROBE);
    const portal = connectivityAlert('portal', null, PROBE);
    expect(offline?.group).toBe(portal?.group);
  });
});

describe('escalates', () => {
  it('is true for a worse level or a new incident, and only then', () => {
    expect(escalates(alert('g', 'partial'), alert('g', 'major'))).toBe(true);
    expect(escalates(alert('g', 'major', ['a']), alert('g', 'major', ['a', 'b']))).toBe(true);
    expect(escalates(alert('g', 'major'), alert('g', 'partial'))).toBe(false);
    expect(escalates(alert('g', 'major', ['a', 'b']), alert('g', 'major', ['a']))).toBe(false);
    expect(escalates(alert('g', 'major', ['a']), alert('g', 'major', ['a']))).toBe(false);
  });
});

describe('reconcile', () => {
  it('raises the popup when something goes bad', () => {
    const result = reconcile(EMPTY_POPUP, [alert('github')]);
    expect(result.raised).toBe(true);
    expect(shownGroups(result.state)).toEqual(['github']);
  });

  it('does not raise again while the same thing stays bad', () => {
    const state = rounds([alert('github')]);
    expect(reconcile(state, [alert('github')]).raised).toBe(false);
  });

  it('updates a shown alert in place as its detail moves on', () => {
    const state = rounds(
      [alert('github', 'major', [], 'Investigating')],
      [alert('github', 'major', [], 'Identified')],
    );
    expect(state.shown).toEqual([alert('github', 'major', [], 'Identified')]);
  });

  it('clears an alert on its own once the check recovers', () => {
    expect(rounds([alert('github')], []).shown).toEqual([]);
  });

  it('raises again for a worse level', () => {
    const state = rounds([alert('github', 'degraded')]);
    const result = reconcile(state, [alert('github', 'major')]);
    expect(result.raised).toBe(true);
    expect(result.state.shown.map((a) => a.level)).toEqual(['major']);
  });

  it('keeps arrival order and appends newcomers', () => {
    const state = rounds([alert('a')], [alert('b'), alert('a')]);
    expect(shownGroups(state)).toEqual(['a', 'b']);
  });

  it('raises only for the newcomer when one more thing breaks', () => {
    const result = reconcile(rounds([alert('a')]), [alert('a'), alert('b')]);
    expect(result.raised).toBe(true);
  });
});

describe('dismiss', () => {
  it('keeps a dismissed alert away while it is still active', () => {
    const closed = dismiss(rounds([alert('a')]), 'a:major');
    const result = reconcile(closed, [alert('a')]);
    expect(result.raised).toBe(false);
    expect(result.state.shown).toEqual([]);
  });

  it('lets the same kind of outage pop again after a recovery', () => {
    const closed = dismiss(rounds([alert('a')]), 'a:major');
    const recovered = reconcile(closed, []).state;
    expect(reconcile(recovered, [alert('a')]).raised).toBe(true);
  });

  it('leaves the others on screen', () => {
    const state = dismiss(rounds([alert('a'), alert('b')]), 'a:major');
    expect(shownGroups(state)).toEqual(['b']);
  });

  it('ignores a key that is not shown', () => {
    const state = rounds([alert('a')]);
    expect(dismiss(state, 'nope')).toBe(state);
  });

  // Regressions from the adversarial review.

  it('stays dismissed when the outage eases (major to partial)', () => {
    const closed = dismiss(rounds([alert('github', 'major')]), 'github:major');
    const result = reconcile(closed, [alert('github', 'partial')]);
    expect(result.raised).toBe(false);
    expect(result.state.shown).toEqual([]);
  });

  it('stays dismissed when one of several incidents resolves', () => {
    const closed = dismiss(rounds([alert('github', 'major', ['a', 'b'])]), 'github:major:a:b');
    expect(reconcile(closed, [alert('github', 'major', ['a'])]).raised).toBe(false);
  });

  it('does not re-pop on every swing of a flapping level', () => {
    const closed = dismiss(rounds([alert('github', 'major')]), 'github:major');
    const eased = reconcile(closed, [alert('github', 'partial')]).state;
    expect(reconcile(eased, [alert('github', 'major')]).raised).toBe(false);
  });

  it('pops again for a new incident, dismissed or not', () => {
    const closed = dismiss(rounds([alert('github', 'major', ['a'])]), 'github:major:a');
    expect(reconcile(closed, [alert('github', 'major', ['a', 'c'])]).raised).toBe(true);
  });

  it('pops again when the outage gets worse than it was when dismissed', () => {
    const closed = dismiss(rounds([alert('github', 'degraded')]), 'github:degraded');
    expect(reconcile(closed, [alert('github', 'major')]).raised).toBe(true);
  });
});

describe('suspended checks (a service while the connection is down)', () => {
  it('keeps a dismissal through a blip, so the same outage does not pop again', () => {
    const closed = dismiss(rounds([alert('github')]), 'github:major');
    const offline = reconcile(closed, [alert('internet')], { suspended: ['github'] }).state;
    const back = reconcile(offline, [alert('github')]);
    expect(back.raised).toBe(false);
    expect(shownGroups(back.state)).toEqual([]);
  });

  it('takes a shown alert off screen while suspended', () => {
    const offline = reconcile(rounds([alert('github')]), [alert('internet')], {
      suspended: ['github'],
    });
    expect(shownGroups(offline.state)).toEqual(['internet']);
  });

  it('still forgets a dismissal once the service truly recovers', () => {
    const closed = dismiss(rounds([alert('github')]), 'github:major');
    const recovered = reconcile(closed, []).state;
    expect(reconcile(recovered, [alert('github')]).raised).toBe(true);
  });
});

describe('held checks (a service whose page can not be read)', () => {
  it('keeps a shown card on screen, so going dark does not read as all clear', () => {
    const held = reconcile(rounds([alert('github')]), [], { held: ['github'] });
    expect(shownGroups(held.state)).toEqual(['github']);
    expect(held.raised).toBe(false);
  });

  it('keeps a dismissal, so the same outage does not pop again when the page returns', () => {
    const closed = dismiss(rounds([alert('github')]), 'github:major');
    const dark = reconcile(closed, [], { held: ['github'] }).state;
    const back = reconcile(dark, [alert('github')]);
    expect(back.raised).toBe(false);
    expect(back.state.shown).toEqual([]);
  });

  it('does not show the card twice when the page returns still bad', () => {
    const dark = reconcile(rounds([alert('github')]), [], { held: ['github'] }).state;
    const back = reconcile(dark, [alert('github')]);
    expect(shownGroups(back.state)).toEqual(['github']);
    expect(back.raised).toBe(false);
  });

  it('only holds the groups it is told to', () => {
    const state = reconcile(rounds([alert('a'), alert('b')]), [], { held: ['a'] }).state;
    expect(shownGroups(state)).toEqual(['a']);
  });

  it('still forgets a dismissal once the service truly recovers', () => {
    const closed = dismiss(rounds([alert('github')]), 'github:major');
    const recovered = reconcile(closed, []).state;
    expect(reconcile(recovered, [alert('github')]).raised).toBe(true);
  });
});

describe('acknowledge', () => {
  it('clears the popup without letting the same alerts pop again', () => {
    const seen = acknowledge(rounds([alert('a')]));
    expect(seen.shown).toEqual([]);
    expect(reconcile(seen, [alert('a')]).raised).toBe(false);
  });
});

describe('resolved cards', () => {
  it('come forward, even for a trouble that was dismissed', () => {
    const closed = dismiss(rounds([alert('github')]), 'github:major');
    const result = reconcile(closed, [], { resolved: [resolvedCard('github')] });
    expect(result.raised).toBe(true);
    expect(result.state.resolved.map((card) => card.group)).toEqual(['github']);
  });

  it('replace the trouble card they are about, in the same pass', () => {
    const result = reconcile(rounds([alert('github')]), [], { resolved: [resolvedCard('github')] });
    expect(result.state.shown).toEqual([]);
    expect(visible(result.state).map((card) => card.title)).toEqual(['github: resolved']);
  });

  it('stay up, with no timer, while the rest of the checks go on', () => {
    const state = reconcile(EMPTY_POPUP, [], { resolved: [resolvedCard('github')] }).state;
    const later = reconcile(state, []);
    expect(later.raised).toBe(false);
    expect(later.state.resolved).toHaveLength(1);
  });

  it('give way to a newer card for the same group', () => {
    const first = reconcile(EMPTY_POPUP, [], { resolved: [resolvedCard('github', 1)] }).state;
    const second = reconcile(first, [], { resolved: [resolvedCard('github', 2)] }).state;
    expect(second.resolved.map((card) => card.key)).toEqual(['resolved:github:2']);
  });

  it('go away when that group turns bad again, because they would be a lie', () => {
    const state = reconcile(EMPTY_POPUP, [], { resolved: [resolvedCard('github')] }).state;
    const again = reconcile(state, [alert('github')]);
    expect(again.raised).toBe(true);
    expect(again.state.resolved).toEqual([]);
    expect(shownGroups(again.state)).toEqual(['github']);
  });

  it("leave other groups' cards alone", () => {
    const state = reconcile(EMPTY_POPUP, [], {
      resolved: [resolvedCard('a'), resolvedCard('b')],
    }).state;
    const again = reconcile(state, [alert('a')]);
    expect(again.state.resolved.map((card) => card.group)).toEqual(['b']);
  });

  it('are closed with dismiss, and are not remembered as a trouble', () => {
    const state = reconcile(EMPTY_POPUP, [], { resolved: [resolvedCard('github')] }).state;
    const closed = dismiss(state, 'resolved:github:1');
    expect(closed.resolved).toEqual([]);
    expect(closed.dismissed).toEqual([]);
    // So the next outage of the same service still pops.
    expect(reconcile(closed, [alert('github')]).raised).toBe(true);
  });

  it('are read, not shown, once the panel says it all (acknowledge)', () => {
    const state = reconcile(EMPTY_POPUP, [], { resolved: [resolvedCard('github')] }).state;
    expect(acknowledge(state).resolved).toEqual([]);
  });
});
