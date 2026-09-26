/**
 * The panel controller.
 *
 * Each round checks the internet connection first, because every other status
 * depends on it, then fetches whichever services are due. One chain of
 * timeouts drives the lot.
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
  fetchStatus,
  loadSettingsJson,
  presentPopup,
  saveSettingsJson,
  probeUrl,
  setTrayStatus,
  showError,
} from './lib/tauri.ts';
import {
  describeFound,
  findExisting,
  judgeCandidate,
  normalizeCandidate,
} from './lib/candidate.ts';
import { parseSettings, serializeSettings } from './lib/settings.ts';
import {
  apiUrl,
  applyFetch,
  displayLevel,
  INITIAL_SERVICE,
  isDue,
  serviceAlert,
  serviceSubtitle,
  summaryUrl,
  type ServiceConfig,
  type ServiceState,
} from './lib/services.ts';
import { LEVEL_LABELS } from './lib/status.ts';
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
  private readonly serviceList = mustGet<HTMLUListElement>('service-list');

  private readonly addOpen = mustGet<HTMLButtonElement>('add-open');
  private readonly addForm = mustGet<HTMLFormElement>('add-form');
  private readonly addUrl = mustGet<HTMLInputElement>('add-url');
  private readonly addSubmit = mustGet<HTMLButtonElement>('add-submit');
  private readonly addCancel = mustGet<HTMLButtonElement>('add-cancel');
  private readonly addMessage = mustGet('add-message');

  /** Empty until `settings.json` has been read; the first round waits for it. */
  private services: readonly ServiceConfig[] = [];
  /** Raised synchronously: a second Enter mustn't start a second check. */
  private adding = false;
  private serviceStates = new Map<string, ServiceState>();
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

  async start(): Promise<void> {
    this.close.addEventListener('click', () => {
      void hidePanel();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      // Esc backs out of the add form first, and only then closes the panel.
      if (!this.addForm.hidden) this.closeAddForm();
      else void hidePanel();
    });

    this.addOpen.addEventListener('click', () => {
      this.openAddForm();
    });
    this.addCancel.addEventListener('click', () => {
      this.closeAddForm();
    });
    this.addForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.addService(this.addUrl.value);
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

    try {
      this.services = parseSettings(await loadSettingsJson()).services;
    } catch (error) {
      // Unreadable (permissions, a locked file): run on the defaults rather
      // than not at all, and say so. Nothing is written until you change
      // something, so the file on disk is left alone.
      this.services = parseSettings(null).services;
      await showError('Could not read your saved status pages', describeError(error));
    }

    this.render();
    void this.checkNow();
  }

  private openAddForm(): void {
    this.addForm.hidden = false;
    this.addOpen.hidden = true;
    this.showAddMessage('', 'info');
    this.addUrl.focus();
  }

  private closeAddForm(): void {
    this.addForm.hidden = true;
    this.addOpen.hidden = false;
    this.addUrl.value = '';
    this.showAddMessage('', 'info');
    this.addOpen.focus();
  }

  private showAddMessage(text: string, tone: 'info' | 'error' | 'success'): void {
    this.addMessage.textContent = text;
    this.addMessage.dataset.tone = tone;
  }

  /**
   * Check that a status page can be watched, and add it only if it can.
   *
   * The address is checked before anything is fetched, then the page's API is
   * fetched once, and only a summary the adapter actually parses is accepted.
   * The list is saved before it changes in memory, so a failed write leaves
   * the app on what is actually on disk.
   */
  private async addService(input: string): Promise<void> {
    if (this.adding) return;
    this.adding = true;
    this.addSubmit.disabled = true;

    try {
      const normalized = normalizeCandidate(input);
      if (!normalized.ok) {
        this.showAddMessage(normalized.error, 'error');
        return;
      }
      // Cheap and certain: no need to ask the network about a page already here.
      const existing = findExisting(normalized.origin, this.services);
      if (existing !== undefined) {
        this.showAddMessage(`You’re already watching this page, as “${existing.name}”.`, 'error');
        return;
      }

      this.showAddMessage(`Checking ${new URL(normalized.origin).host}…`, 'info');
      const outcome = await fetchStatus(summaryUrl(normalized.origin), null);
      const verdict = judgeCandidate(normalized.origin, outcome, this.services);
      if (!verdict.ok) {
        this.showAddMessage(verdict.error, 'error');
        return;
      }

      const next = [...this.services, verdict.service];
      try {
        await saveSettingsJson(serializeSettings({ services: next }));
      } catch (error) {
        this.showAddMessage(`Couldn’t save it: ${describeError(error)}`, 'error');
        return;
      }

      this.services = next;
      // The check already fetched the page; use that reading rather than
      // showing the new row as "checking" until the next round.
      const states = new Map(this.serviceStates);
      states.set(
        verdict.service.id,
        applyFetch(verdict.service, INITIAL_SERVICE, outcome, Date.now()),
      );
      this.serviceStates = states;
      // You were just told its state; don't pop it up at you as news.
      this.popup = acknowledge(reconcile(this.popup, this.activeAlerts()).state);

      this.addUrl.value = '';
      this.showAddMessage(describeFound(verdict), 'success');
      this.render();
    } finally {
      this.adding = false;
      this.addSubmit.disabled = false;
    }
  }

  /** Stop watching a service. Saved first, like adding. */
  private async removeService(service: ServiceConfig): Promise<void> {
    const next = this.services.filter((candidate) => candidate.id !== service.id);
    try {
      await saveSettingsJson(serializeSettings({ services: next }));
    } catch (error) {
      await showError(`Could not stop watching ${service.name}`, describeError(error));
      return;
    }
    this.services = next;
    const states = new Map(this.serviceStates);
    states.delete(service.id);
    this.serviceStates = states;
    this.render();
    await this.syncPopup();
  }

  /**
   * Fetch every service that is due, in parallel.
   *
   * Driven by the connection check's own timer rather than one of its own:
   * one chain of timeouts for the whole app, and each service's `nextAt`
   * decides whether this round includes it.
   */
  private async pollServices(): Promise<void> {
    const now = Date.now();
    const due = this.services.filter((service) => isDue(this.stateOf(service), now));
    const results = await Promise.all(
      due.map(async (service) => ({
        service,
        outcome: await fetchStatus(apiUrl(service), this.stateOf(service).etag),
      })),
    );
    const next = new Map(this.serviceStates);
    // The list can change while the fetches are out (a service added or
    // removed from the panel); only keep results for services still in it.
    const current = new Set(this.services.map((service) => service.id));
    for (const { service, outcome } of results) {
      if (!current.has(service.id)) continue;
      next.set(service.id, applyFetch(service, this.stateOf(service), outcome, Date.now()));
    }
    this.serviceStates = next;
  }

  private stateOf(service: ServiceConfig): ServiceState {
    return this.serviceStates.get(service.id) ?? INITIAL_SERVICE;
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
      // Services only while online: offline, every fetch would fail, and each
      // failure would count toward calling a healthy vendor "unknown".
      if (this.connectivity.status === 'online') await this.pollServices();
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
    this.serviceList.hidden = this.services.length === 0;
    this.serviceList.replaceChildren(...this.services.map((service) => this.serviceRow(service)));
    void this.pushTrayLine();
  }

  /** One service. Its subtitle can come off the network: `textContent` only. */
  private serviceRow(service: ServiceConfig): HTMLLIElement {
    const state = this.stateOf(service);
    const connection = this.connectivity.status;
    const online = connection === 'online';
    const level = displayLevel(state);
    // On hold means the connection is known to be the problem. While it is
    // still being checked at launch, the service is simply checking too.
    const held = connection === 'offline' || connection === 'portal';
    const shown = held ? 'hold' : (level ?? 'checking');

    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row service-row';
    button.dataset.service = service.id;
    button.dataset.state = shown;
    button.title = `Open ${service.pageUrl}`;
    button.addEventListener('click', () => {
      void this.open(service.pageUrl);
    });

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'row-text';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = service.name;
    text.append(name);
    const subtitle = serviceSubtitle(state, online);
    if (subtitle !== null) {
      const small = document.createElement('span');
      small.className = 'row-subtitle';
      small.textContent = subtitle;
      text.append(small);
    }

    const label = document.createElement('span');
    label.className = 'row-level';
    label.textContent =
      shown === 'hold' ? 'on hold' : shown === 'checking' ? 'checking…' : LEVEL_LABELS[shown];

    button.append(dot, text, label);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button service-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Stop watching ${service.name}`);
    remove.title = `Stop watching ${service.name}`;
    remove.addEventListener('click', () => {
      void this.removeService(service);
    });

    item.className = 'service-item';
    item.append(button, remove);
    return item;
  }

  /**
   * Everything wrong right now, as alerts. While the connection is down, its
   * alert is the only one: every service would otherwise read as broken for
   * a reason that has nothing to do with the vendor.
   */
  private activeAlerts(): Alert[] {
    const probe = PROBES[0]?.url ?? '';
    const internet = connectivityAlert(this.connectivity.status, this.portalUrl, probe);
    if (internet !== null) return [internet];
    if (this.connectivity.status !== 'online') return [];
    return this.services
      .map((service) => serviceAlert(service, this.stateOf(service)))
      .filter((alert): alert is Alert => alert !== null);
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
    const entries: TrayEntry[] = this.services.map((service) => ({
      name: service.name,
      level: displayLevel(this.stateOf(service)),
    }));
    const line = formatTrayStatus(entries, this.connectivity.status);
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

void new PanelController().start();
