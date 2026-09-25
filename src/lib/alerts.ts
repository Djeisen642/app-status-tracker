/**
 * The popup: which bad states it shows, and when it shows them again.
 *
 * Every check reports what is wrong *now* as a list of alerts. The popup is
 * driven by the difference between that list and what it has already shown, so
 * it appears when something goes bad, not on every check while it stays bad.
 * A dismissed alert stays dismissed until its check recovers or gets worse.
 */

import type { Connectivity } from './connectivity.ts';
import type { Level } from './status.ts';

export interface AlertLink {
  readonly label: string;
  /** Opened by Rust, which refuses anything but http(s). Treat as untrusted. */
  readonly url: string;
}

export interface Alert {
  /**
   * What makes this alert *this* alert. Built from the check, the level and
   * the incident, so the same outage re-checked keeps its key, while a worse
   * level or a new incident gets a new one and pops again.
   */
  readonly key: string;
  readonly level: Level;
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
        level: 'major',
        title: 'No internet connection',
        detail: 'Service status is on hold until it’s back.',
        link: null,
      };
    case 'portal':
      return {
        key: 'internet:portal',
        level: 'degraded',
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
  /** Keys the user closed, remembered while the alert is still active. */
  readonly dismissed: readonly string[];
}

export const EMPTY_POPUP: PopupState = { shown: [], dismissed: [] };

export interface Reconciled {
  readonly state: PopupState;
  /** `true` when something new arrived, i.e. the popup should come forward. */
  readonly raised: boolean;
}

/**
 * Fold what is wrong right now into the popup.
 *
 * - A new key arrives: shown, and `raised` so the window comes up.
 * - A key already shown: stays, updated in place (its detail may have moved on).
 * - A key no longer active: removed, so recovery clears the popup by itself.
 * - A dismissed key: stays hidden while active, forgotten once it clears, so
 *   the next outage of the same kind pops again.
 */
export function reconcile(state: PopupState, active: readonly Alert[]): Reconciled {
  const activeKeys = new Set(active.map((alert) => alert.key));
  const byKey = new Map(active.map((alert) => [alert.key, alert]));

  const dismissed = state.dismissed.filter((key) => activeKeys.has(key));
  const kept = state.shown
    .map((alert) => byKey.get(alert.key))
    .filter((alert): alert is Alert => alert !== undefined);

  const known = new Set([...kept.map((alert) => alert.key), ...dismissed]);
  const arrived = active.filter((alert) => !known.has(alert.key));

  return {
    state: { shown: [...kept, ...arrived], dismissed },
    raised: arrived.length > 0,
  };
}

/** Close one alert. It won't come back until its check recovers or changes. */
export function dismiss(state: PopupState, key: string): PopupState {
  if (!state.shown.some((alert) => alert.key === key)) return state;
  return {
    shown: state.shown.filter((alert) => alert.key !== key),
    dismissed: [...state.dismissed, key],
  };
}

/**
 * Mark alerts as seen without showing them: for when the panel is already
 * open and says the same thing, so a popup would only repeat it.
 */
export function acknowledge(state: PopupState): PopupState {
  return {
    shown: [],
    dismissed: [...state.dismissed, ...state.shown.map((alert) => alert.key)],
  };
}
