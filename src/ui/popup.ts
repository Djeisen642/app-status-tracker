/**
 * The popup: which alerts are on it, drawing them, and turning the one window
 * into the popup and back.
 *
 * The rules for *when* something pops are pure and live in `lib/alerts.ts`;
 * this is the part with a DOM and a window. The window itself is sized while
 * hidden and shown only after the page has switched to popup mode (see
 * `preparePopup` / `revealPopup`), and it never takes focus.
 */

import {
  acknowledge,
  dismiss,
  EMPTY_POPUP,
  reconcile,
  visible,
  type Alert,
  type PopupState,
  type ReconcileOptions,
} from '../lib/alerts.ts';
import { describeError } from '../lib/errors.ts';
import { toneOf } from '../lib/summary.ts';
import { hidePanel, preparePopup, presentPanel, revealPopup, showError } from '../lib/tauri.ts';
import { closeIcon, forwardIcon } from './icons.ts';

export class Popup {
  private state: PopupState = EMPTY_POPUP;
  /** What was last drawn, so an unchanged popup isn't rebuilt under the pointer. */
  private drawn = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly list: HTMLUListElement,
    /** Opens a link (a status page, a sign-in page). */
    private readonly openLink: (url: string) => void,
  ) {}

  /**
   * Bring the popup in line with what is wrong now: raise it, update it, or
   * close it. `options` says what can't be judged right now, and which
   * troubles were just seen to end (see `reconcile`).
   */
  async sync(active: readonly Alert[], options: ReconcileOptions = {}): Promise<void> {
    const { state, raised } = reconcile(this.state, active, options);
    this.state = state;
    this.draw();

    if (visible(this.state).length === 0) {
      if (isPopupMode()) await this.close();
      return;
    }
    // Only something new brings the popup forward; an update to one already
    // showing just resizes it in place.
    if (raised || isPopupMode()) await this.show();
  }

  /**
   * Take in what is wrong now as already seen, without showing it: the user
   * was just told (they added the page).
   */
  acknowledgeAll(active: readonly Alert[], options: ReconcileOptions = {}): void {
    this.state = acknowledge(reconcile(this.state, active, options).state);
    this.draw();
  }

  /**
   * Mark what is on the popup as seen. Only what is shown: reconciling here
   * against an empty list would read as "everything recovered" and forget
   * every dismissal, which the e2e suite caught during a refactor.
   */
  private acknowledgeShown(): void {
    this.state = acknowledge(this.state);
    this.draw();
  }

  /** The window became the panel: whatever the popup said, the panel says too. */
  becamePanel(): void {
    this.acknowledgeShown();
    setMode('panel');
  }

  private async show(): Promise<void> {
    // Measured while still hidden: the popup is laid out off-screen in panel
    // mode precisely so this works without flashing it inside an open panel.
    const height = Math.ceil(this.root.getBoundingClientRect().height);
    try {
      const prepared = await preparePopup(height);
      if (!prepared) {
        // The panel is open and already says it.
        this.acknowledgeShown();
        return;
      }
      setMode('popup');
      await revealPopup();
    } catch (error) {
      // Its own message: this is the popup failing, not the connection check.
      await showError('Could not show the status popup', describeError(error));
    }
  }

  private async close(): Promise<void> {
    await hidePanel();
    setMode('panel');
  }

  private async dismiss(key: string): Promise<void> {
    this.state = dismiss(this.state, key);
    this.draw();
    if (visible(this.state).length === 0) await this.close();
    else await this.show();
  }

  private async openPanel(): Promise<void> {
    this.acknowledgeShown();
    setMode('panel');
    await presentPanel();
  }

  /** Rebuilt only when what it says changed, so a click isn't lost to a redraw. */
  private draw(): void {
    const cards = visible(this.state);
    const drawn = JSON.stringify(cards.map((alert) => [alert.key, alert.detail]));
    if (drawn === this.drawn) return;
    this.drawn = drawn;
    this.list.replaceChildren(...cards.map((alert) => this.card(alert)));
  }

  /** One alert. Everything in it came off the network: `textContent` only. */
  private card(alert: Alert): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'alert';
    row.dataset.tone = toneOf(alert.level);
    row.title = 'Open the status panel';
    // Clicking the card itself opens the full panel; its buttons do their own thing.
    row.addEventListener('click', () => {
      void this.openPanel();
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
      // Decoration stays out of the accessible name: an aria-hidden SVG, not CSS
      // generated content (read aloud as "right arrow") or a Unicode glyph.
      link.append(forwardIcon());
      link.addEventListener('click', (event) => {
        event.stopPropagation();
        this.openLink(url);
      });
      text.append(link);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button alert-close';
    close.append(closeIcon());
    close.setAttribute('aria-label', `Dismiss: ${alert.title}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.dismiss(alert.key);
    });

    row.append(dot, text, close);
    return row;
  }
}

function isPopupMode(): boolean {
  return document.body.dataset.mode === 'popup';
}

function setMode(mode: 'panel' | 'popup'): void {
  document.body.dataset.mode = mode;
}
