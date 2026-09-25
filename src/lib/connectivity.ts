/**
 * "Is it them, or is it me?": the internet connection check.
 *
 * Every status page the app watches is useless while the machine itself is
 * offline, and worse than useless if a failed fetch is shown as that vendor's
 * outage. So connectivity is checked on its own, against endpoints that exist
 * for exactly this job, and everything else defers to it.
 *
 * Rust makes the requests (`src-tauri/src/probe.rs`); this module decides what
 * they mean.
 */

import { SECOND } from './time.ts';

/** What one probe saw, exactly as the bridge reports it. */
export type ProbeOutcome =
  | { kind: 'response'; status: number; location: string | null; body: string }
  /** The browser build can reach the URL but may not read the answer (no-cors). */
  | { kind: 'opaque' }
  | { kind: 'error'; message: string };

export interface Probe {
  readonly name: string;
  /** Plain HTTP on purpose: a captive portal can only intercept an unencrypted request. */
  readonly url: string;
  readonly expectStatus: number;
  /** When set, the trimmed body must equal this exactly. */
  readonly expectBody?: string;
}

/**
 * The OS vendors' own connectivity checks: Android/ChromeOS and Windows run
 * these constantly, which is why they are fast, stable and answer with a fixed
 * tiny body. Two providers, so one of them having a bad day isn't read as the
 * whole internet being down.
 *
 * Their expected answers are the documented ones, not yet observed from this
 * sandbox (its network policy blocks them). Confirm them from a real machine.
 */
export const PROBES: readonly Probe[] = [
  {
    name: 'Google',
    url: 'http://connectivitycheck.gstatic.com/generate_204',
    expectStatus: 204,
  },
  {
    name: 'Microsoft',
    url: 'http://www.msftconnecttest.com/connecttest.txt',
    expectStatus: 200,
    expectBody: 'Microsoft Connect Test',
  },
];

/** One probe, judged. */
export type ProbeVerdict = 'ok' | 'portal' | 'failed';

/**
 * Judge one probe's answer.
 *
 * An answer that isn't the expected one is a captive portal: something on the
 * network intercepted a request whose correct answer is fixed and known. That
 * includes a redirect, which is how most portals answer, and a 200 carrying a
 * login page where a 204 belonged.
 */
export function judgeProbe(probe: Probe, outcome: ProbeOutcome): ProbeVerdict {
  switch (outcome.kind) {
    case 'error':
      return 'failed';
    case 'opaque':
      return 'ok';
    case 'response': {
      if (outcome.status !== probe.expectStatus) return 'portal';
      if (probe.expectBody !== undefined && outcome.body.trim() !== probe.expectBody) {
        return 'portal';
      }
      return 'ok';
    }
  }
}

/**
 * Combine one round of probes into one observation.
 *
 * Any probe succeeding means online: two independent providers failing
 * together is the signal, one failing alone is their problem. A portal on any
 * probe beats a plain failure, because "sign in to the Wi-Fi" is actionable
 * and "offline" is not.
 */
export function combineVerdicts(verdicts: readonly ProbeVerdict[]): ProbeVerdict {
  if (verdicts.includes('ok')) return 'ok';
  if (verdicts.includes('portal')) return 'portal';
  return 'failed';
}

export type Connectivity = 'checking' | 'online' | 'offline' | 'portal';

export interface ConnectivityState {
  readonly status: Connectivity;
  /** Consecutive failed rounds. */
  readonly failures: number;
}

export const INITIAL_CONNECTIVITY: ConnectivityState = { status: 'checking', failures: 0 };

/**
 * Failed rounds in a row before the app says "offline". One dropped round is a
 * Wi-Fi roam or a sleeping radio, and an "offline" that flickers on every one
 * of those gets ignored. Recovery takes a single success.
 */
export const OFFLINE_AFTER = 2;

/**
 * Fold one observation into the state.
 *
 * `browserOffline` is `navigator.onLine === false`, which is the one reading
 * of that flag worth trusting: it can say "online" behind a dead router, but
 * when it says offline there is no network interface up at all. That skips the
 * wait for a second failed round.
 */
export function observe(
  state: ConnectivityState,
  verdict: ProbeVerdict,
  browserOffline = false,
): ConnectivityState {
  if (browserOffline)
    return { status: 'offline', failures: Math.max(state.failures, OFFLINE_AFTER) };

  switch (verdict) {
    case 'ok':
      return { status: 'online', failures: 0 };
    case 'portal':
      return { status: 'portal', failures: 0 };
    case 'failed': {
      const failures = state.failures + 1;
      return { status: failures >= OFFLINE_AFTER ? 'offline' : state.status, failures };
    }
  }
}

/**
 * How long until the next check.
 *
 * Quick while in doubt (starting up, or one round has failed) so a real
 * outage is confirmed in seconds, and every 30s otherwise. Rechecking offline
 * or behind a portal every 10s is what makes recovery feel immediate.
 */
export function nextCheckDelay(state: ConnectivityState): number {
  if (state.status === 'checking' || (state.status === 'online' && state.failures > 0)) {
    return 5 * SECOND;
  }
  if (state.status === 'online') return 30 * SECOND;
  return 10 * SECOND;
}

/** The tray line's override while the connection is the problem, else `null`. */
export function connectivityTrayLine(status: Connectivity): string | null {
  switch (status) {
    case 'offline':
      return 'Offline: no internet connection';
    case 'portal':
      return 'Offline: Wi-Fi sign-in required';
    case 'checking':
    case 'online':
      return null;
  }
}

/** How the connection reads in the panel's Internet row. */
export const CONNECTIVITY_LABELS: Readonly<Record<Connectivity, string>> = {
  checking: 'checking…',
  online: 'connected',
  offline: 'no connection',
  portal: 'sign-in required',
};
