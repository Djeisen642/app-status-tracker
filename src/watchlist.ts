/**
 * The watched list, and every change to it.
 *
 * Owns `settings.json`: reading it, refusing to save over a file it couldn't
 * understand, queueing changes so two can't overwrite each other, and the add
 * flow that proves a page watchable before it joins the list. The rules are in
 * CLAUDE.md under "The watched list"; each was a bug first.
 */

import {
  describeFound,
  findExisting,
  judgeCandidate,
  normalizeCandidate,
} from './lib/candidate.ts';
import { describeError } from './lib/errors.ts';
import { summaryUrl, type FetchOutcome, type ServiceConfig } from './lib/services.ts';
import {
  DEFAULT_SETTINGS,
  readSettings,
  serializeSettings,
  type Settings,
} from './lib/settings.ts';
import { fetchStatus, loadSettingsJson, saveSettingsJson } from './lib/tauri.ts';

/** Why add and remove refuse while the file on disk couldn't be read. */
export const LOCKED =
  'Your saved status pages couldn’t be read, so changes aren’t being saved over them. Fix or remove settings.json, then restart the app.';

export type AddResult =
  | {
      readonly ok: true;
      readonly message: string;
      readonly service: ServiceConfig;
      /** The check's own fetch, so the new row needn't wait for the next round. */
      readonly outcome: FetchOutcome;
    }
  | { readonly ok: false; readonly message: string };

export class WatchList {
  /** Empty until `load`; the first round waits for it. */
  private settings: Settings = { ...DEFAULT_SETTINGS, services: [] };
  private canSave = true;
  /** Every change goes through this chain, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  get services(): readonly ServiceConfig[] {
    return this.settings.services;
  }

  /** `false` when saving would overwrite a file that couldn't be read or understood. */
  get writable(): boolean {
    return this.canSave;
  }

  /**
   * Read `settings.json`. Resolves with the reason it couldn't be read, or
   * `null`; either way there is a list to run on.
   */
  async load(): Promise<string | null> {
    try {
      const loaded = readSettings(await loadSettingsJson());
      this.settings = loaded.settings;
      this.canSave = loaded.writable;
      return loaded.writable ? null : 'settings.json isn’t valid settings.';
    } catch (error) {
      // Unreadable (a sync client or antivirus holding the file, permissions):
      // run on the defaults rather than not at all, and never save over it.
      this.settings = DEFAULT_SETTINGS;
      this.canSave = false;
      return describeError(error);
    }
  }

  /**
   * Check that a status page can be watched, and add it only if it can.
   *
   * The address is checked before anything is fetched, then the page's API is
   * fetched once, and only a summary the adapter actually parses is accepted.
   * `progress` hears what is happening while the fetch is out.
   */
  async add(input: string, progress: (message: string) => void): Promise<AddResult> {
    if (!this.canSave) return { ok: false, message: LOCKED };

    const normalized = normalizeCandidate(input);
    if (!normalized.ok) return { ok: false, message: normalized.error };
    // Cheap and certain: no need to ask the network about a page already here.
    const existing = findExisting(normalized.origin, this.services);
    if (existing !== undefined) {
      return { ok: false, message: `You’re already watching this page, as “${existing.name}”.` };
    }

    progress(`Checking ${new URL(normalized.origin).host}…`);
    const outcome = await fetchStatus(summaryUrl(normalized.origin), null);
    const verdict = judgeCandidate(normalized.origin, outcome, this.services);
    if (!verdict.ok) return { ok: false, message: verdict.error };

    let added: boolean;
    try {
      // Re-checked inside the queue: another add may have landed first.
      added = await this.change((current) =>
        findExisting(verdict.service.pageUrl, current) === undefined
          ? [...current, verdict.service]
          : null,
      );
    } catch (error) {
      return { ok: false, message: `Couldn’t save it: ${describeError(error)}` };
    }
    if (!added) return { ok: false, message: 'You’re already watching this page.' };

    return { ok: true, message: describeFound(verdict), service: verdict.service, outcome };
  }

  /** Stop watching a service. Rejects with a reason when it can't be saved. */
  async remove(id: string): Promise<void> {
    if (!this.canSave) throw new Error(LOCKED);
    await this.change((current) => current.filter((service) => service.id !== id));
  }

  /**
   * Change the list: saved first, then applied, one change at a time.
   *
   * `change` runs against the list as it is *when its turn comes*, not as it
   * was when the click happened, so an add and a remove that overlap both
   * land. Saved before memory changes, so a failed write leaves the app on
   * what is actually on disk. Resolves `false` when `change` declines.
   */
  private change(
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
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
