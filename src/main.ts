/**
 * The panel controller.
 *
 * The internet connection is checked for real: every status the app will ever
 * show depends on it, so it comes first. Services themselves arrive in phase 1
 * (see `docs/future-work.md`), so their list is still empty.
 *
 * The one window has two modes. The panel is what a tray click opens. The
 * popup is the same window shrunk to a small card, shown without focus when a
 * check goes bad, with a link to the page that explains it.
 */

import {
  acknowledge,
  connectivityAlert,
  dismiss,
  EMPTY_POPUP,
  reconcile,
  type Alert,
  type PopupState,
} from './lib/alerts.ts';
import {
  combineVerdicts,
  CONNECTIVITY_LABELS,
  INITIAL_CONNECTIVITY,
  judgeProbe,
  nextCheckDelay,
  observe,
  portalLocation,
  PROBES,
  type ConnectivityState,
} from './lib/connectivity.ts';
import { describeError } from './lib/errors.ts';
import type { Level } from './lib/status.ts';
import {
  hidePanel,
  onShowPanel,
  openUrl,
  presentPanel,
  presentPopup,
  probeUrl,
  setTrayStatus,
  showError,
} from './lib/tauri.ts';
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
  private readonly popupList = mustGet<HTMLUListElement>('popup-list');

  private readonly services: readonly TrayEntry[] = [];
  private connectivity: ConnectivityState = INITIAL_CONNECTIVITY;
  /** Where a captive portal last redirected a probe, for the sign-in link. */
  private portalUrl: string | null = null;
  private popup: PopupState = EMPTY_POPUP;
  private lastChecked: Date | null = null;

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

    // Whatever the popup was saying, the panel now says it too.
    void onShowPanel(() => {
      this.popup = acknowledge(this.popup);
      this.setMode('panel');
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
      const results = browserOffline
        ? []
        : await Promise.all(
            PROBES.map(async (probe) => ({ probe, outcome: await probeUrl(probe.url) })),
          );
      const verdicts = results.map(({ probe, outcome }) => judgeProbe(probe, outcome));
      this.connectivity = observe(this.connectivity, combineVerdicts(verdicts), browserOffline);
      this.portalUrl = portalLocation(results);
      this.lastChecked = new Date();
      this.shownError = null;
      this.render();
      await this.syncPopup();
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
    if (this.lastChecked !== null) {
      const time = this.lastChecked.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      this.internet.title = `Last checked ${time}`;
    }
    this.offlineNote.hidden = status !== 'offline' && status !== 'portal';
    this.offlineNote.textContent =
      status === 'portal'
        ? 'This network wants you to sign in before it lets anything through. Open a browser to get past it.'
        : 'Service status is on hold until the connection is back.';

    this.empty.hidden = this.services.length > 0;
    void this.pushTrayLine();
  }

  /** Everything wrong right now, as alerts. Services join this list in phase 1. */
  private activeAlerts(): Alert[] {
    const probe = PROBES[0]?.url ?? '';
    const internet = connectivityAlert(this.connectivity.status, this.portalUrl, probe);
    return internet === null ? [] : [internet];
  }

  /** Bring the popup in line with what is wrong now: raise it, update it, or close it. */
  private async syncPopup(): Promise<void> {
    const { state, raised } = reconcile(this.popup, this.activeAlerts());
    this.popup = state;
    this.renderPopup();

    if (this.popup.shown.length === 0) {
      if (document.body.dataset.mode === 'popup') await this.closePopup();
      return;
    }
    // Only something new brings the popup forward; an update to one already
    // showing just resizes it in place.
    if (raised || document.body.dataset.mode === 'popup') await this.showPopup();
  }

  private async showPopup(): Promise<void> {
    // Measured while still hidden: the popup is laid out off-screen in panel
    // mode precisely so this works without flashing it inside an open panel.
    const height = Math.ceil(mustGet('popup').getBoundingClientRect().height);
    let shown: boolean;
    try {
      shown = await presentPopup(height);
    } catch (error) {
      // Its own message: this is the popup failing, not the connection check.
      await showError('Could not show the status popup', describeError(error));
      return;
    }
    if (shown) {
      this.setMode('popup');
    } else {
      // The panel is open and already says it.
      this.popup = acknowledge(this.popup);
      this.renderPopup();
    }
  }

  private async closePopup(): Promise<void> {
    await hidePanel();
    this.setMode('panel');
  }

  private setMode(mode: 'panel' | 'popup'): void {
    document.body.dataset.mode = mode;
  }

  private renderPopup(): void {
    this.popupList.replaceChildren(...this.popup.shown.map((alert) => this.alertRow(alert)));
  }

  /** One alert. Everything in it came off the network: `textContent` only. */
  private alertRow(alert: Alert): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'alert';
    row.dataset.tone = tone(alert.level);
    row.title = 'Open the status panel';
    // Clicking the card itself opens the full panel; its buttons do their own thing.
    row.addEventListener('click', () => {
      void this.openPanelFromPopup();
    });

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('div');
    text.className = 'alert-text';
    const title = document.createElement('p');
    title.className = 'alert-title';
    title.textContent = alert.title;
    const detail = document.createElement('p');
    detail.className = 'alert-detail';
    detail.textContent = alert.detail;
    text.append(title, detail);

    if (alert.link !== null) {
      const { label, url } = alert.link;
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'alert-link';
      link.textContent = label;
      link.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.open(url);
      });
      text.append(link);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button alert-close';
    close.textContent = '×';
    close.setAttribute('aria-label', `Dismiss: ${alert.title}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.dismissAlert(alert.key);
    });

    row.append(dot, text, close);
    return row;
  }

  private async dismissAlert(key: string): Promise<void> {
    this.popup = dismiss(this.popup, key);
    this.renderPopup();
    if (this.popup.shown.length === 0) await this.closePopup();
    else await this.showPopup();
  }

  private async openPanelFromPopup(): Promise<void> {
    this.popup = acknowledge(this.popup);
    this.renderPopup();
    this.setMode('panel');
    await presentPanel();
  }

  private async open(url: string): Promise<void> {
    try {
      await openUrl(url);
    } catch (error) {
      await showError('Could not open the page', describeError(error));
    }
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

/** How loudly a level is drawn in the popup. */
function tone(level: Level): 'bad' | 'warn' | 'idle' {
  switch (level) {
    case 'major':
    case 'partial':
      return 'bad';
    case 'degraded':
    case 'maintenance':
      return 'warn';
    case 'operational':
    case 'unknown':
      return 'idle';
  }
}

new PanelController().start();
