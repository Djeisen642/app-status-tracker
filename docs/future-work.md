# Future work

Everything we want built, in one place. The **MVP line** divides what has to
work before this is worth running daily from what can come later.

Status keys: **done** · **partial** · **todo**

---

## Phase 0: the scaffold

| Status | Item                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| done   | Tauri v2 + vanilla TypeScript + Vite, tooling copied from task-tracker: type-aware lint, Prettier, Vitest, Lefthook, Playwright. |
| done   | Derived versioning: `scripts/version.ts`, the `commit-msg` hook, `release.yml`. Starts at 0.1.0.                                 |
| done   | CI: web gate, e2e with screenshots, and the full Rust gate (`fmt`, `clippy -D warnings`, `check`, `test`).                       |
| done   | Tray icon with a status line, **Show status** and **Quit**; left click toggles the panel.                                        |
| done   | Opaque, frameless panel parked top-right on the largest display; closes on Esc or ×.                                             |
| done   | The status model (`Level`, `worstLevel`) and the tray line (`formatTrayStatus`), tested.                                         |
| done   | Two icon masters, with the small one hand-tuned for 16–32px.                                                                     |

## Above the MVP line

### Phase 1: one adapter, end to end

| Status | Item                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| todo   | `fetch_status(url, etag)` in Rust: reqwest with rustls, http(s) only, redirects followed, 10s timeout, ~2 MB body cap. The webview never fetches: the CSP is `connect-src 'self' ipc:` and most status APIs send no CORS headers, and a scoped `tauri-plugin-http` fails silently when the scope is wrong. |
| todo   | Statuspage adapter over `/api/v2/summary.json`: pure TypeScript, normalizing into `Level`, tested against fixtures captured from real pages (all-green **and** mid-incident).                                                                                                                              |
| todo   | Poller on a 30s tick that asks which services are _due_, like task-tracker's slots, never a `setInterval` per service. 60s floor, jitter, ETag, exponential backoff to 15 min on failure.                                                                                                                  |
| todo   | Service rows in the panel (dot, name, level, current incident, link to the source page).                                                                                                                                                                                                                   |
| todo   | The tray icon recolors its dot to the worst level. Icons swap only when the aggregate changes.                                                                                                                                                                                                             |
| todo   | Services configured in `settings.json` by hand, until phase 3.                                                                                                                                                                                                                                             |

### Phase 2: tell me when it changes

| Status | Item                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| todo   | Native notifications on transitions only, keyed on `(service, incidentId, level)`. Recovery notifies too.                                                                                |
| todo   | Last-known state persisted to `state.json` (atomic write), so a relaunch mid-incident doesn't re-notify about the incident you already know about.                                       |
| todo   | Offline detection: every fetch failing in the same tick means the problem is local. The tray says "Offline" rather than showing every service unknown and sending one notification each. |
| todo   | Settle the history log format (see below) so nothing is lost before it's built.                                                                                                          |

### Phase 3: settings

| Status | Item                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| todo   | Add a service by **pasting its status page URL**. The app probes `/api/v2/summary.json`, then `/summary.json` (Instatus), then an RSS/Atom `<link rel="alternate">`, then falls back to a plain HTTP check, and saves the resolved kind and URL once. |
| todo   | Component filters, picked from a live fetch. Required, not optional: GitHub's page covers Actions, Pages, Codespaces and Copilot, and a tracker that goes amber whenever Codespaces does gets muted within a week.                                    |
| todo   | Settings overlay in the one window (task-tracker's pattern), `parseSettings` repairs / `validateDraft` reports.                                                                                                                                       |
| todo   | Launch at login.                                                                                                                                                                                                                                      |

---

# ═══════════ MVP LINE ═══════════

### Phase 4: more adapters

| Status | Item                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| todo   | AWS Health Dashboard, public feed. Not the authenticated Health API: that needs Business support and credentials in a tray app. Verify the endpoint live first; it is unofficial.                        |
| todo   | Generic RSS/Atom (Azure, Slack, anything without JSON).                                                                                                                                                  |
| todo   | Google Cloud `incidents.json`, Instatus, incident.io, each verified live before building.                                                                                                                |
| todo   | Plain HTTP check for your own endpoints: expected status, latency threshold, two consecutive failures before red (Statuspage feeds are already debounced by the humans posting them; a raw probe isn't). |

### Later

| Status | Item                                                                                                                                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| todo   | Append-only `history/YYYY-MM.md` of transitions, so an agent can answer "how many hours was vendor X degraded this year?" at renewal time. Task-tracker's vault idea, pointed at vendors.                                                      |
| todo   | Hide the panel when it loses focus. Deliberately not in phase 0: clicking the tray icon blurs the panel first, so a naive hide-on-blur makes the click that should close it reopen it instead. Needs a debounce and a real desktop to test on. |

## Open questions

- **Which provider hosts `status.cursor.com`?** Not verified; the sandbox's
  network policy blocks it. If it serves a Statuspage-compatible
  `/api/v2/summary.json`, phase 1 covers it with no extra work.

## Known unknowns

Reviewed for correctness, never executed. Nothing in this sandbox can run a
desktop webview.

- **Everything native, on every platform.** Tray icon, left-click toggle, menu
  events, top-right positioning on a multi-monitor mixed-DPI setup, the
  frameless opaque window, `skipTaskbar`, always-on-top. Windows is the platform
  to check first; macOS and Linux after.
- **Linux tray clicks.** Most Linux panels (AppIndicator) never deliver the
  icon's click event, only the menu. **Show status** is in the menu for that
  reason; whether left click works at all there is unknown.
- **Windows toasts (phase 2).** A notification from an unpackaged `tauri dev`
  build is attributed to the wrong app; only the installed MSI registers the
  proper AppUserModelID. Check on an installed build, not a dev one.
