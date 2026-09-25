/**
 * The panel controller.
 *
 * The internet connection is checked for real: every status the app will ever
 * show depends on it, so it comes first. Services themselves arrive in phase 1
 * (see `docs/future-work.md`), so their list is still empty.
 */

import {
  combineVerdicts,
  CONNECTIVITY_LABELS,
  INITIAL_CONNECTIVITY,
  judgeProbe,
  nextCheckDelay,
  observe,
  PROBES,
  type ConnectivityState,
} from './lib/connectivity.ts';
import { describeError } from './lib/errors.ts';
import { hidePanel, probeUrl, setTrayStatus, showError } from './lib/tauri.ts';
import { formatTrayStatus, type TrayEntry } from './lib/tray.ts';

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id} in index.html`);
  return element as T;
}

class PanelController {
  private readonly empty = mustGet('empty');
  private readonly close = mustGet<HTMLButtonElement>('close');
  private readonly internet = mustGet('internet');
  private readonly internetLevel = mustGet('internet-level');
  private readonly offlineNote = mustGet('offline-note');

  private readonly services: readonly TrayEntry[] = [];
  private connectivity: ConnectivityState = INITIAL_CONNECTIVITY;

  /** Raised synchronously before the first `await`: a flag set after one is not a guard. */
  private checking = false;
  private timer: number | undefined;
  /** The last bridge failure shown, so a persistent one isn't a dialog every 5s. */
  private shownError: string | null = null;
  /** The last line pushed to the tray, so an unchanged one isn't re-sent. */
  private trayLine: string | null = null;

  start(): void {
    this.close.addEventListener('click', () => {
      void hidePanel();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') void hidePanel();
    });

    // The OS noticing a network change is the best moment to look again,
    // rather than whenever the timer next happens to fire.
    window.addEventListener('online', () => {
      void this.checkNow();
    });
    window.addEventListener('offline', () => {
      void this.checkNow();
    });

    this.render();
    void this.checkNow();
  }

  /**
   * Run one round of probes, then schedule the next.
   *
   * A chain of timeouts, not an interval: after the machine sleeps, the one
   * pending timeout fires once on wake instead of a backlog of checks.
   */
  private async checkNow(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    window.clearTimeout(this.timer);

    try {
      // Read before the probes run, so a `navigator.onLine === false` skips
      // waiting for them to time out.
      const browserOffline = !navigator.onLine;
      const verdicts = browserOffline
        ? []
        : await Promise.all(
            PROBES.map(async (probe) => judgeProbe(probe, await probeUrl(probe.url))),
          );
      this.connectivity = observe(this.connectivity, combineVerdicts(verdicts), browserOffline);
      this.shownError = null;
      this.render();
    } catch (error) {
      // A bridge failure is the app's problem, not the network's: say so,
      // rather than folding it into "offline". Once per distinct failure.
      const detail = describeError(error);
      if (detail !== this.shownError) {
        this.shownError = detail;
        await showError('Could not check the internet connection', detail);
      }
    } finally {
      this.checking = false;
      this.timer = window.setTimeout(() => {
        void this.checkNow();
      }, nextCheckDelay(this.connectivity));
    }
  }

  private render(): void {
    const status = this.connectivity.status;
    this.internet.dataset.state = status;
    this.internetLevel.textContent = CONNECTIVITY_LABELS[status];
    this.offlineNote.hidden = status !== 'offline' && status !== 'portal';
    this.offlineNote.textContent =
      status === 'portal'
        ? 'This network wants you to sign in before it lets anything through. Open a browser to get past it.'
        : 'Service status is on hold until the connection is back.';

    this.empty.hidden = this.services.length > 0;
    void this.pushTrayLine();
  }

  private async pushTrayLine(): Promise<void> {
    const line = formatTrayStatus(this.services, this.connectivity.status);
    if (line === this.trayLine) return;
    this.trayLine = line;
    try {
      await setTrayStatus(line);
    } catch (error) {
      await showError('Could not update the tray', describeError(error));
    }
  }
}

new PanelController().start();
