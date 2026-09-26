/**
 * The app's loop and its wiring.
 *
 * Each round checks the internet connection first, because every other status
 * depends on it, then fetches whichever services are due. One chain of
 * timeouts drives the lot. Everything else is delegated:
 *
 * - `WatchList` owns the list of services and `settings.json`.
 * - `ServiceList`, `Popup` and `AddForm` (in `ui/`) own their parts of the page.
 * - The rules themselves are pure, in `lib/`.
 *
 * The one window has two modes. The panel is what a tray click opens. The
 * popup is the same window shrunk to a small card, shown without focus when a
 * check goes bad, with a link to the page that explains it.
 */

import { connectivityAlert, type Alert } from './lib/alerts.ts';
import { formatBuildInfo } from './lib/build-info.ts';
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
import {
  apiUrl,
  applyFetch,
  displayLevel,
  INITIAL_SERVICE,
  isDue,
  rowView,
  serviceAlert,
  type ServiceConfig,
  type ServiceState,
} from './lib/services.ts';
import { headline, type Tone } from './lib/summary.ts';
import {
  fetchStatus,
  hidePanel,
  onShowPanel,
  openUrl,
  probeUrl,
  setTrayIcon,
  setTrayStatus,
  showError,
} from './lib/tauri.ts';
import { formatTrayStatus, type TrayEntry } from './lib/tray.ts';
import { AddForm } from './ui/add-form.ts';
import { Popup } from './ui/popup.ts';
import { ServiceList } from './ui/service-list.ts';
import { Settings } from './ui/settings.ts';
import { WatchList } from './watchlist.ts';

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id} in index.html`);
  return element as T;
}

class App {
  private readonly internet = mustGet('internet');
  private readonly internetLevel = mustGet('internet-level');
  private readonly hero = mustGet('hero');
  private readonly heroTitle = mustGet('hero-title');
  private readonly heroDetail = mustGet('hero-detail');
  private readonly checked = mustGet('checked');
  private readonly servicesLabel = mustGet('services-label');
  private readonly serviceListElement = mustGet<HTMLUListElement>('service-list');
  private readonly empty = mustGet('empty');
  private readonly settingsProblem = mustGet('settings-problem');

  private readonly watchlist = new WatchList();
  private readonly rows = new ServiceList(this.serviceListElement, {
    open: (id) => {
      const service = this.find(id);
      if (service !== undefined) void this.open(service.pageUrl);
    },
    remove: (id) => {
      void this.remove(id);
    },
  });
  private readonly popup = new Popup(mustGet('popup'), mustGet('popup-list'), (url) => {
    void this.open(url);
  });
  private readonly addForm = new AddForm(
    {
      open: mustGet('add-open'),
      form: mustGet('add-form'),
      input: mustGet('add-url'),
      submit: mustGet('add-submit'),
      cancel: mustGet('add-cancel'),
      message: mustGet('add-message'),
    },
    (input, say) => this.add(input, say),
  );
  private readonly settings = new Settings(
    {
      open: mustGet('settings-open'),
      overlay: mustGet('settings'),
      close: mustGet('settings-close'),
      buildInfo: mustGet('build-info'),
      content: mustGet('panel-content'),
    },
    formatBuildInfo({
      version: __APP_VERSION__,
      commit: __BUILD_COMMIT__,
      builtAt: __BUILD_DATE__,
    }),
  );

  private serviceStates = new Map<string, ServiceState>();
  private connectivity: ConnectivityState = INITIAL_CONNECTIVITY;
  /** Where a captive portal last redirected a probe, for the sign-in link. */
  private portalUrl: string | null = null;
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
  /** The last tone the tray icon was recolored to, so an unchanged one isn't re-sent. */
  private trayTone: Tone | null = null;
  /** The last tray icon failure shown, so a persistent one isn't a dialog every round. */
  private trayIconError: string | null = null;

  private get services(): readonly ServiceConfig[] {
    return this.watchlist.services;
  }

  async start(): Promise<void> {
    mustGet('close').addEventListener('click', () => {
      void hidePanel();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      // Esc backs out of an open overlay first, and only then closes the panel.
      if (this.settings.isOpen) this.settings.close();
      else if (this.addForm.isOpen) this.addForm.close();
      else void hidePanel();
    });

    // The OS noticing a network change is the best moment to look again,
    // rather than whenever the timer next happens to fire.
    window.addEventListener('online', () => {
      void this.checkNow();
    });
    window.addEventListener('offline', () => {
      void this.checkNow();
    });

    void onShowPanel(() => {
      this.popup.becamePanel();
    });

    const problem = await this.watchlist.load();
    this.settingsProblem.hidden = problem === null;
    if (problem !== null) this.settingsProblem.title = problem;

    this.render();
    void this.checkNow();
  }

  /** The add form's submit: runs the add, then shows the new row's state at once. */
  private async add(
    input: string,
    say: (text: string, tone: 'info' | 'error' | 'success') => void,
  ): Promise<boolean> {
    const result = await this.watchlist.add(input, (progress) => {
      say(progress, 'info');
    });
    if (!result.ok) {
      say(result.message, 'error');
      return false;
    }

    // The check already fetched the page; use that reading rather than
    // showing the new row as "checking" until the next round.
    const states = new Map(this.serviceStates);
    states.set(
      result.service.id,
      applyFetch(result.service, INITIAL_SERVICE, result.outcome, Date.now()),
    );
    this.serviceStates = states;
    // You were just told its state; don't pop it up at you as news.
    const { active, suspended } = this.alerts();
    this.popup.acknowledgeAll(active, suspended);

    say(result.message, 'success');
    this.render();
    return true;
  }

  private async remove(id: string): Promise<void> {
    const service = this.find(id);
    if (service === undefined) return;
    try {
      await this.watchlist.remove(id);
    } catch (error) {
      await showError(`Could not stop watching ${service.name}`, describeError(error));
      return;
    }
    const states = new Map(this.serviceStates);
    states.delete(id);
    this.serviceStates = states;
    this.render();
    const { active, suspended } = this.alerts();
    await this.popup.sync(active, suspended);
  }

  private find(id: string): ServiceConfig | undefined {
    return this.services.find((service) => service.id === id);
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
      const { active, suspended } = this.alerts();
      await this.popup.sync(active, suspended);
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
    this.serviceListElement.hidden = none;
    this.servicesLabel.hidden = none;
    this.rows.render(
      this.services.map((service) => ({
        id: service.id,
        name: service.name,
        pageUrl: service.pageUrl,
        view: rowView(this.stateOf(service), status),
      })),
    );
    void this.pushTrayLine();
    void this.pushTrayIcon(summary.tone);
  }

  private trayEntries(): TrayEntry[] {
    return this.services.map((service) => ({
      name: service.name,
      level: displayLevel(this.stateOf(service)),
    }));
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

  /**
   * Recolor the tray icon if the aggregate tone changed. Remembered only once
   * the tray took it, for the same reason as `pushTrayLine`: caching it first
   * would leave the icon stale after a failed call.
   */
  private async pushTrayIcon(tone: Tone): Promise<void> {
    if (tone === this.trayTone) return;
    try {
      await setTrayIcon(tone);
      this.trayTone = tone;
      this.trayIconError = null;
    } catch (error) {
      const detail = describeError(error);
      if (detail === this.trayIconError) return;
      this.trayIconError = detail;
      await showError('Could not update the tray icon', detail);
    }
  }
}

void new App().start();
