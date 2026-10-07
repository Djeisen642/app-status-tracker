/**
 * The popup: which bad states it shows, and when it shows them again.
 *
 * Every check reports what is wrong *now* as a list of alerts. The popup is
 * driven by the difference between that list and what it has already shown, so
 * it appears when something goes bad, not on every check while it stays bad.
 * A dismissed alert stays dismissed until its check recovers or gets worse.
 * When a service's trouble ends, the popup says so once (a `resolved` card,
 * built in `episodes.ts`) rather than just going quiet.
 */

import type { Connectivity } from './connectivity.ts';
import { isWorse, type Level } from './status.ts';

export interface AlertLink {
  readonly label: string;
  /** Opened by Rust, which refuses anything but http(s). Treat as untrusted. */
  readonly url: string;
}

export interface Alert {
  /** Identifies this alert on screen, for dismissing it. */
  readonly key: string;
  /**
   * The check it comes from: one service, or the connection. Alerts in the
   * same group are the same trouble developing, and are compared with each
   * other rather than treated as strangers (see `escalates`).
   */
  readonly group: string;
  readonly level: Level;
  /** Open incident ids, so a *new* incident can be told from an old one. */
  readonly incidents: readonly string[];
  readonly title: string;
  readonly detail: string;
  /** The status page (or sign-in page) to open. `null` when there is nothing to open. */
  readonly link: AlertLink | null;
}

/**
 * The internet connection's alert, or `null` while it's fine or unknown yet.
 *
 * `portalUrl` is where a captive portal redirected the probe. It is the most
 * useful link in the app: the page you have to visit before anything else
 * works. Without one, the probe URL itself is offered, because a browser
 * sent there gets redirected to the portal too.
 */
export function connectivityAlert(
  status: Connectivity,
  portalUrl: string | null,
  probeUrl: string,
): Alert | null {
  switch (status) {
    case 'offline':
      return {
        key: 'internet:offline',
        group: 'internet',
        level: 'major',
        incidents: [],
        title: 'No internet connection',
        detail: 'Service status is on hold until it’s back.',
        link: null,
      };
    case 'portal':
      return {
        key: 'internet:portal',
        group: 'internet',
        level: 'degraded',
        incidents: [],
        title: 'Wi-Fi sign-in required',
        detail: 'This network wants you to sign in before it lets anything through.',
        link: { label: 'Open the sign-in page', url: portalUrl ?? probeUrl },
      };
    case 'checking':
    case 'online':
      return null;
  }
}

export interface PopupState {
  /** On screen now, in the order they arrived. */
  readonly shown: readonly Alert[];
  /**
   * What the user closed, per group, remembered while that trouble lasts. Each
   * holds the *peak* seen since (worst level, every incident), so a level that
   * flaps between partial and major doesn't pop again on every swing up.
   */
  readonly dismissed: readonly Alert[];
  /**
   * Good news waiting to be read: a trouble that ended. At most one per group,
   * and never remembered once closed (it isn't trouble, so nothing to suppress).
   */
  readonly resolved: readonly Alert[];
}

export const EMPTY_POPUP: PopupState = { shown: [], dismissed: [], resolved: [] };

/** Everything the popup has a card for, in the order it is drawn. */
export function visible(state: PopupState): readonly Alert[] {
  return [...state.shown, ...state.resolved];
}

export interface Reconciled {
  readonly state: PopupState;
  /** `true` when something new or worse arrived, i.e. the popup should come forward. */
  readonly raised: boolean;
}

/**
 * Is `next` news compared with `seen`? Only if it is worse, or brings an
 * incident that wasn't there. Getting better, or one of several incidents
 * resolving, is not news: an adversarial review caught both re-popping a
 * dismissed popup, when the key still carried the level and incident list.
 */
export function escalates(seen: Alert, next: Alert): boolean {
  return (
    isWorse(next.level, seen.level) || next.incidents.some((id) => !seen.incidents.includes(id))
  );
}

export interface ReconcileOptions {
  /**
   * Groups whose trouble isn't known to be over but shouldn't be on screen:
   * the connection is down, or the page has moved into maintenance. Taken off
   * screen, dismissal kept.
   */
  readonly suspended?: readonly string[];
  /**
   * Groups that can't be judged right now because their page can't be read:
   * left exactly as they are, on screen or dismissed. Not being able to see
   * is not the same as it being over.
   */
  readonly held?: readonly string[];
  /** Cards for troubles that were seen to end. */
  readonly resolved?: readonly Alert[];
}

/**
 * Fold what is wrong right now into the popup.
 *
 * - A new group arrives: shown, and `raised` so the window comes up.
 * - A group already shown: updated in place; raised again only if it escalated.
 * - A dismissed group: stays hidden while it lasts, unless it escalates.
 * - A group no longer active: removed, and its dismissal forgotten, so the
 *   next outage of the same kind pops again.
 * - A *suspended* group (a service while the connection is down: still
 *   broken as far as anyone knows, just not being checked) is taken off screen
 *   but keeps its dismissal. Treating "not checked right now" as "recovered"
 *   was the other bug the review found: a Wi-Fi blip re-popped every
 *   dismissed outage.
 * - A *held* group (a service whose page can't be read) keeps whatever it
 *   had. A page buckling in a big outage must not make the card vanish, which
 *   reads as all clear, or forget a dismissal, which re-pops the same outage
 *   when the page returns.
 * - A *resolved* card arrives for a group whose trouble was seen to end. It
 *   comes forward like any news, replaces an older card for the same group,
 *   and goes away if that group turns bad again (it would be a lie by then).
 *   Whether a group really ended is decided by the caller from a fresh good
 *   reading, never from the group merely being absent from `active`.
 */
export function reconcile(
  state: PopupState,
  active: readonly Alert[],
  options: ReconcileOptions = {},
): Reconciled {
  const suspendedGroups = new Set(options.suspended ?? []);
  const heldGroups = new Set(options.held ?? []);
  const resolved = options.resolved ?? [];

  const shown: Alert[] = [];
  let raised = false;
  // Keep what was already on screen in its place, updated.
  for (const previous of state.shown) {
    const next = active.find((alert) => alert.group === previous.group);
    if (next === undefined) {
      if (heldGroups.has(previous.group)) shown.push(previous);
      continue;
    }
    if (escalates(previous, next)) raised = true;
    shown.push(next);
  }

  const dismissed: Alert[] = [];
  for (const previous of state.dismissed) {
    const next = active.find((alert) => alert.group === previous.group);
    if (next === undefined) {
      if (suspendedGroups.has(previous.group) || heldGroups.has(previous.group)) {
        dismissed.push(previous);
      }
      continue;
    }
    if (escalates(previous, next)) {
      shown.push(next);
      raised = true;
    } else {
      dismissed.push(peak(previous, next));
    }
  }

  const known = new Set([...shown, ...dismissed].map((alert) => alert.group));
  for (const alert of active) {
    if (known.has(alert.group)) continue;
    shown.push(alert);
    raised = true;
  }

  const activeGroups = new Set(active.map((alert) => alert.group));
  const arrived = resolved.filter((card) => !activeGroups.has(card.group));
  const arrivedGroups = new Set(arrived.map((card) => card.group));
  const kept = state.resolved.filter(
    (card) => !activeGroups.has(card.group) && !arrivedGroups.has(card.group),
  );

  return {
    state: { shown, dismissed, resolved: [...kept, ...arrived] },
    raised: raised || arrived.length > 0,
  };
}

/**
 * Close one card. A trouble won't come back until its check recovers or gets
 * worse; a resolved card is just closed.
 */
export function dismiss(state: PopupState, key: string): PopupState {
  const closing = state.shown.find((alert) => alert.key === key);
  if (closing === undefined) {
    return state.resolved.some((card) => card.key === key)
      ? { ...state, resolved: state.resolved.filter((card) => card.key !== key) }
      : state;
  }
  return {
    ...state,
    shown: state.shown.filter((alert) => alert !== closing),
    dismissed: [...state.dismissed.filter((alert) => alert.group !== closing.group), closing],
  };
}

/**
 * Mark everything as seen without showing it: for when the panel is already
 * open and says the same thing, so a popup would only repeat it. Resolved
 * cards are simply read.
 */
export function acknowledge(state: PopupState): PopupState {
  const groups = new Set(state.shown.map((alert) => alert.group));
  return {
    shown: [],
    dismissed: [...state.dismissed.filter((alert) => !groups.has(alert.group)), ...state.shown],
    resolved: [],
  };
}

/** The worst of two sightings of the same trouble: its level, and every incident. */
function peak(seen: Alert, next: Alert): Alert {
  return {
    ...next,
    level: isWorse(seen.level, next.level) ? seen.level : next.level,
    incidents: [...new Set([...seen.incidents, ...next.incidents])],
  };
}
