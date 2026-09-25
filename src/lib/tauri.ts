/**
 * Thin, optional bridge to the Tauri runtime.
 *
 * The frontend is built to run in a plain browser tab (for fast iteration with
 * `pnpm run dev`) *and* inside the Tauri webview. Every call here degrades
 * gracefully when the Tauri APIs are absent, so the UI never hard-crashes
 * outside the desktop shell, and the panel can be designed in a browser without
 * a Rust build in the loop.
 */

import type { ProbeOutcome } from './connectivity.ts';

/** `true` only when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Hide the window, whether it is showing the panel or the popup. Showing the
 * panel is the tray's job (`src-tauri/src/lib.rs`).
 */
export async function hidePanel(): Promise<void> {
  if (!isTauri()) return;

  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().hide();
}

/**
 * GET a connectivity probe once.
 *
 * On the desktop, Rust makes the request (`probe.rs`) and reports the status,
 * any redirect and the start of the body. A browser can't do that for another
 * origin: a `no-cors` fetch either reaches the URL or doesn't, and hides the
 * answer. So the browser build can tell online from offline but never sees a
 * captive portal; that path is covered by unit tests instead.
 */
export async function probeUrl(url: string): Promise<ProbeOutcome> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<ProbeOutcome>('http_probe', { url });
  }

  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return { kind: 'opaque' };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Show the popup, `height` CSS pixels tall, without taking focus.
 *
 * Resolves `false` when the panel is already open and nothing was shown. In a
 * browser there is no window to manage, so the page itself becomes the popup.
 */
export async function presentPopup(height: number): Promise<boolean> {
  if (!isTauri()) return true;

  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<boolean>('present_popup', { height });
}

/** Grow the popup into the full panel, focused. Rust announces it with `show-panel`. */
export async function presentPanel(): Promise<void> {
  if (!isTauri()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('present_panel');
}

/** Called whenever the window becomes the panel: a tray click, or the popup clicked. */
export async function onShowPanel(handler: () => void): Promise<void> {
  if (!isTauri()) return;

  const { listen } = await import('@tauri-apps/api/event');
  await listen('show-panel', () => {
    handler();
  });
}

/**
 * Open a status page in the browser. Rust holds the URL to http(s) first; the
 * browser build gets the same check here, since it has no Rust to do it.
 */
export async function openUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_url', { url });
    return;
  }

  const protocol = new URL(url).protocol;
  if (protocol === 'http:' || protocol === 'https:') window.open(url, '_blank', 'noopener');
}

/** Update the tray's status line. */
export async function setTrayStatus(status: string): Promise<void> {
  if (!isTauri()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_tray_status', { status });
}

/**
 * Surface an error to the user with a native dialog.
 *
 * Polling runs on a timer while the window is hidden, so a `console.error` (or
 * a webview `alert()` from a hidden window) is invisible, exactly when a broken
 * fetch is the thing you most need to know about.
 */
export async function showError(title: string, detail: string): Promise<void> {
  if (!isTauri()) {
    if (typeof window !== 'undefined') window.alert(`${title}\n\n${detail}`);
    return;
  }

  const { message } = await import('@tauri-apps/plugin-dialog');
  await message(detail, { title, kind: 'error' });
}
