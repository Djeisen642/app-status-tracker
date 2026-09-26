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
  preparePopup,
  revealPopup,
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
import {
  DEFAULT_SETTINGS,
  readSettings,
  serializeSettings,
  type Settings,
} from './lib/settings.ts';
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
import { headline } from './lib/summary.ts';
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
  private readonly hero = mustGet('hero');
  private readonly heroTitle = mustGet('hero-title');
  private readonly heroDetail = mustGet('hero-detail');
  private readonly checked = mustGet('checked');
  private readonly servicesLabel = mustGet('services-label');
  private readonly popupList = mustGet<HTMLUListElement>('popup-list');
  private readonly serviceList = mustGet<HTMLUListElement>('service-list');

  private readonly addOpen = mustGet<HTMLButtonElement>('add-open');
  private readonly addForm = mustGet<HTMLFormElement>('add-form');
  private readonly addUrl = mustGet<HTMLInputElement>('add-url');
  private readonly addSubmit = mustGet<HTMLButtonElement>('add-submit');
  private readonly addCancel = mustGet<HTMLButtonElement>('add-cancel');
  private readonly addMessage = mustGet('add-message');
  private readonly settingsProblem = mustGet('settings-problem');

  /** Empty until `settings.json` has been read; the first round waits for it. */
  private settings: Settings = { ...DEFAULT_SETTINGS, services: [] };
  /**
   * `false` when the file on disk couldn't be read or understood. The app then
   * runs on the defaults in memory and refuses to save, because saving would
   * replace the real list with defaults-plus-one-change.
   */
  private settingsWritable = true;
  /** Every change to the list goes through this chain, one at a time. */
  private settingsWrite: Promise<unknown> = Promise.resolve();
  /** Service rows by id, updated in place so focus and clicks survive a render. */
  private readonly rows = new Map<string, ServiceRow>();
  /** What the popup last drew, so an unchanged popup isn't rebuilt under the pointer. */
  private popupDrawn = '';
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
  /** The last line the tray accepted, so an unchanged one isn't re-sent. */
  private trayLine: string | null = null;
  /** The last tray failure shown, so a persistent one isn't a dialog every round. */
  private trayError: string | null = null;

  private get services(): readonly ServiceConfig[] {
    return this.settings.services;
  }

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
      const loaded = readSettings(await loadSettingsJson());
      this.settings = loaded.settings;
      this.settingsWritable = loaded.writable;
    } catch (error) {
      // Unreadable (a sync client or antivirus holding the file, permissions):
      // run on the defaults rather than not at all, and never save over it.
      this.settings = DEFAULT_SETTINGS;
      this.settingsWritable = false;
      this.settingsProblem.title = describeError(error);
    }
    this.settingsProblem.hidden = this.settingsWritable;

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
      if (!this.settingsWritable) {
        this.showAddMessage(LOCKED, 'error');
        return;
      }
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

      let added: boolean;
      try {
        // Re-checked inside the queue: another add may have landed first.
        added = await this.changeServices((current) =>
          findExisting(verdict.service.pageUrl, current) === undefined
            ? [...current, verdict.service]
            : null,
        );
      } catch (error) {
        this.showAddMessage(`Couldn’t save it: ${describeError(error)}`, 'error');
        return;
      }
      if (!added) {
        this.showAddMessage('You’re already watching this page.', 'error');
        return;
      }

      // The check already fetched the page; use that reading rather than
      // showing the new row as "checking" until the next round.
      const states = new Map(this.serviceStates);
      states.set(
        verdict.service.id,
        applyFetch(verdict.service, INITIAL_SERVICE, outcome, Date.now()),
      );
      this.serviceStates = states;
      // You were just told its state; don't pop it up at you as news.
      const { active, suspended } = this.alerts();
      this.popup = acknowledge(reconcile(this.popup, active, suspended).state);

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
    if (!this.settingsWritable) {
      await showError(`Could not stop watching ${service.name}`, LOCKED);
      return;
    }
    try {
      await this.changeServices((current) =>
        current.filter((candidate) => candidate.id !== service.id),
      );
    } catch (error) {
      await showError(`Could not stop watching ${service.name}`, describeError(error));
      return;
    }
    const states = new Map(this.serviceStates);
    states.delete(service.id);
    this.serviceStates = states;
    this.render();
    await this.syncPopup();
  }

  /**
   * Change the list: saved first, then applied, one change at a time.
   *
   * `change` runs against the list as it is *when its turn comes*, not as it
   * was when the click happened, so an add and a remove that overlap both
   * land. Without the queue each built its list from the same starting point
   * and the later save silently undid the earlier one. Returns `false` when
   * `change` declines (returns `null`).
   */
  private changeServices(
    change: (current: readonly ServiceConfig[]) => readonly ServiceConfig[] | null,
  ): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const services = change(this.services);
      if (services === null) return false;
      const next = { ...this.settings, services };
      await saveSettingsJson(serializeSettings(next));
      this.settings = next;
      return true;
    };
    const result = this.settingsWrite.then(run, run);
    this.settingsWrite = result.catch(() => undefined);
    return result;
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
      // Services only while the connection is plainly fine: offline, or in the
      // round after a failed probe, their fetches fail for local reasons, and
      // each failure counts toward calling a healthy vendor "unknown".
      if (this.connectivity.status === 'online' && this.connectivity.failures === 0) {
        await this.pollServices();
      }
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
      const time = (options: Intl.DateTimeFormatOptions) =>
        this.lastChecked?.toLocaleTimeString([], options) ?? '';
      // Seconds in the tooltip, minutes on screen: the harness waits on the
      // former, and nobody needs to read seconds at a glance.
      this.internet.title = `Last checked ${time({ hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      this.checked.textContent = `Checked ${time({ hour: 'numeric', minute: '2-digit' })}`;
    }

    const summary = headline(status, this.trayEntries());
    this.hero.dataset.tone = summary.tone;
    this.heroTitle.textContent = summary.title;
    this.heroDetail.textContent = summary.detail;

    const none = this.services.length === 0;
    this.empty.hidden = !none;
    this.serviceList.hidden = none;
    this.servicesLabel.hidden = none;
    this.renderRows();
    void this.pushTrayLine();
  }

  private trayEntries(): TrayEntry[] {
    return this.services.map((service) => ({
      name: service.name,
      level: displayLevel(this.stateOf(service)),
    }));
  }

  /**
   * Bring the service rows in line with the list, updating each in place.
   *
   * Rebuilding them every round (every 5 to 30 seconds) threw away keyboard
   * focus mid-Tab, and dropped a click whose press and release straddled a
   * rebuild. Rows are created once per service and only their contents
   * change; a row is only moved when the order actually changed, because
   * moving a node blurs it.
   */
  private renderRows(): void {
    const ids = new Set(this.services.map((service) => service.id));
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue;
      row.item.remove();
      this.rows.delete(id);
    }

    this.services.forEach((service, index) => {
      let row = this.rows.get(service.id);
      if (row === undefined) {
        row = this.createRow(service.id);
        this.rows.set(service.id, row);
      }
      this.updateRow(row, service);
      if (this.serviceList.children[index] !== row.item) {
        this.serviceList.insertBefore(row.item, this.serviceList.children[index] ?? null);
      }
    });
  }

  /** A row's elements. Its handlers look the service up by id when clicked. */
  private createRow(id: string): ServiceRow {
    const item = document.createElement('li');
    item.className = 'service-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row service-row';
    button.dataset.service = id;
    button.addEventListener('click', () => {
      const service = this.services.find((candidate) => candidate.id === id);
      if (service !== undefined) void this.open(service.pageUrl);
    });

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'row-text';
    const name = document.createElement('span');
    name.className = 'row-name';
    const subtitle = document.createElement('span');
    subtitle.className = 'row-subtitle';
    text.append(name, subtitle);

    const label = document.createElement('span');
    label.className = 'row-level pill';
    button.append(dot, text, label);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button service-remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const service = this.services.find((candidate) => candidate.id === id);
      if (service !== undefined) void this.removeService(service);
    });

    item.append(button, remove);
    return { item, button, name, subtitle, label, remove };
  }

  /** Everything in a row that can change. Network text: `textContent` only. */
  private updateRow(row: ServiceRow, service: ServiceConfig): void {
    const state = this.stateOf(service);
    const connection = this.connectivity.status;
    const level = displayLevel(state);
    // On hold means the connection is known to be the problem. While it is
    // still being checked at launch, the service is simply checking too.
    const held = connection === 'offline' || connection === 'portal';
    const shown = held ? 'hold' : (level ?? 'checking');

    row.button.dataset.state = shown;
    row.button.title = `Open ${service.pageUrl}`;
    row.name.textContent = service.name;
    const subtitle = serviceSubtitle(state, connection === 'online');
    row.subtitle.textContent = subtitle ?? '';
    row.subtitle.hidden = subtitle === null;
    row.label.textContent =
      shown === 'hold' ? 'on hold' : shown === 'checking' ? 'checking…' : LEVEL_LABELS[shown];
    row.remove.setAttribute('aria-label', `Stop watching ${service.name}`);
    row.remove.title = `Stop watching ${service.name}`;
  }

  /**
   * Everything wrong right now, as alerts, split in two.
   *
   * While the connection is down its alert is the only *active* one: every
   * service would otherwise read as broken for a reason that has nothing to
   * do with the vendor. The services' last known alerts are *suspended*
   * rather than dropped, so a dismissal survives the blip instead of the same
   * outage popping again when the Wi-Fi comes back.
   */
  private alerts(): { active: Alert[]; suspended: Alert[] } {
    const probe = PROBES[0]?.url ?? '';
    const internet = connectivityAlert(this.connectivity.status, this.portalUrl, probe);
    const services = this.services
      .map((service) => serviceAlert(service, this.stateOf(service)))
      .filter((alert): alert is Alert => alert !== null);
    if (internet !== null) return { active: [internet], suspended: services };
    if (this.connectivity.status !== 'online') return { active: [], suspended: services };
    return { active: services, suspended: [] };
  }

  /** Bring the popup in line with what is wrong now: raise it, update it, or close it. */
  private async syncPopup(): Promise<void> {
    const { active, suspended } = this.alerts();
    const { state, raised } = reconcile(this.popup, active, suspended);
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
    try {
      // Two steps, so the window never shows the panel's first frame at the
      // popup's size: size it while hidden, switch what the page draws, let
      // that paint, and only then show it.
      const prepared = await preparePopup(height);
      if (!prepared) {
        // The panel is open and already says it.
        this.popup = acknowledge(this.popup);
        this.renderPopup();
        return;
      }
      this.setMode('popup');
      await revealPopup();
    } catch (error) {
      // Its own message: this is the popup failing, not the connection check.
      await showError('Could not show the status popup', describeError(error));
    }
  }

  private async closePopup(): Promise<void> {
    await hidePanel();
    this.setMode('panel');
  }

  private setMode(mode: 'panel' | 'popup'): void {
    document.body.dataset.mode = mode;
  }

  /** Rebuilt only when what it says changed, so a click isn't lost to a redraw. */
  private renderPopup(): void {
    const drawn = JSON.stringify(this.popup.shown.map((alert) => [alert.key, alert.detail]));
    if (drawn === this.popupDrawn) return;
    this.popupDrawn = drawn;
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
      const arrow = document.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';
      link.append(arrow);
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

  /**
   * Push the tray line if it changed. Remembered only once the tray took it:
   * caching it before the call meant one failure left the tray stale until the
   * text happened to change. A persistent failure is shown once, not per round.
   */
  private async pushTrayLine(): Promise<void> {
    const line = formatTrayStatus(this.trayEntries(), this.connectivity.status);
    if (line === this.trayLine) return;
    try {
      await setTrayStatus(line);
      this.trayLine = line;
      this.trayError = null;
    } catch (error) {
      const detail = describeError(error);
      if (detail === this.trayError) return;
      this.trayError = detail;
      await showError('Could not update the tray', detail);
    }
  }
}

interface ServiceRow {
  readonly item: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly name: HTMLSpanElement;
  readonly subtitle: HTMLSpanElement;
  readonly label: HTMLSpanElement;
  readonly remove: HTMLButtonElement;
}

const LOCKED =
  'Your saved status pages couldn’t be read, so changes aren’t being saved over them. Fix or remove settings.json, then restart the app.';

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
