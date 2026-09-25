/**
 * The panel controller.
 *
 * Nothing is fetched yet, so the panel only knows its empty state. The status
 * model and the tray line are real; the adapters, the poller and the rows they
 * fill arrive next (see `docs/future-work.md`).
 */

import { describeError } from './lib/errors.ts';
import { hidePanel, setTrayStatus, showError } from './lib/tauri.ts';
import { formatTrayStatus, type TrayEntry } from './lib/tray.ts';

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id} in index.html`);
  return element as T;
}

class PanelController {
  private readonly empty = mustGet('empty');
  private readonly close = mustGet<HTMLButtonElement>('close');

  private readonly services: readonly TrayEntry[] = [];

  start(): void {
    this.close.addEventListener('click', () => {
      void hidePanel();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') void hidePanel();
    });

    this.empty.hidden = this.services.length > 0;
    void this.pushTrayLine();
  }

  private async pushTrayLine(): Promise<void> {
    try {
      await setTrayStatus(formatTrayStatus(this.services));
    } catch (error) {
      await showError('Could not update the tray', describeError(error));
    }
  }
}

new PanelController().start();
