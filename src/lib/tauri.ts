/**
 * Thin, optional bridge to the Tauri runtime.
 *
 * The frontend is built to run in a plain browser tab (for fast iteration with
 * `pnpm run dev`) *and* inside the Tauri webview. Every call here degrades
 * gracefully when the Tauri APIs are absent, so the UI never hard-crashes
 * outside the desktop shell, and the panel can be designed in a browser without
 * a Rust build in the loop.
 */

/** `true` only when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Hide the panel. Showing it is the tray's job (`src-tauri/src/lib.rs`),
 * because every way in is a click on the tray.
 */
export async function hidePanel(): Promise<void> {
  if (!isTauri()) return;

  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().hide();
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
