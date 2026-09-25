# Future work

Everything we want built, in one place. The **MVP line** divides what has to
work before this is worth running daily from what can come later.

Status keys: **done** · **partial** · **todo**

---

## Phase 0: the scaffold

| Status | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done   | Tauri v2 + vanilla TypeScript + Vite, tooling copied from task-tracker: type-aware lint, Prettier, Vitest, Lefthook, Playwright.                                                                                                                                                                                                                                                                                                                    |
| done   | Derived versioning: `scripts/version.ts`, the `commit-msg` hook, `release.yml`. Starts at 0.1.0.                                                                                                                                                                                                                                                                                                                                                    |
| done   | CI: web gate, e2e with screenshots, and the full Rust gate (`fmt`, `clippy -D warnings`, `check`, `test`).                                                                                                                                                                                                                                                                                                                                          |
| done   | Tray icon with a status line, **Show status** and **Quit**; left click toggles the panel.                                                                                                                                                                                                                                                                                                                                                           |
| done   | Opaque, frameless panel parked top-right on the largest display; closes on Esc or ×.                                                                                                                                                                                                                                                                                                                                                                |
| done   | The status model (`Level`, `worstLevel`) and the tray line (`formatTrayStatus`), tested.                                                                                                                                                                                                                                                                                                                                                            |
| done   | **Internet connection check.** Plain-HTTP probes to Google's and Microsoft's connectivity endpoints, made from Rust (`probe.rs`, no redirects followed, 5s timeout, 1 KB body cap) and judged in `connectivity.ts`. Online if either answers correctly, captive portal if an answer is wrong or a redirect, offline after two failed rounds (or at once if the OS reports no network). Shown as the panel's first row and overriding the tray line. |
| done   | **A popup when a check goes bad.** The window shrinks to a small card in the top-right corner, shown without taking focus, with a link to the page that explains it. Pops on a transition, closes itself on recovery, stays dismissed until the next outage, doesn't pop over an open panel. Clicking it opens the panel. The internet check is the only check wired to it so far; services join in phase 1.                                        |
| done   | Two icon masters, with the small one hand-tuned for 16–32px.                                                                                                                                                                                                                                                                                                                                                                                        |

## Above the MVP line

### Phase 1: one adapter, end to end

| Status  | Item                                                                                                                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done    | `fetch_status(url, etag)` in Rust: native TLS (see CLAUDE.md for why not rustls), system proxy, http(s) only, up to 5 redirects followed, 10s timeout, 2 MB cap. Tested against local sockets; a real HTTPS fetch through the sandbox proxy is an opt-in test (`cargo test -- --ignored`).           |
| partial | Statuspage adapter over `/api/v2/summary.json`, tested against a **real all-green GitHub capture**. The non-operational mapping is Statuspage's documented vocabulary, exercised by labelled synthetic variants; **no capture taken during an incident yet**. Unrecognized values read as `unknown`. |
| done    | Polling rides the connection check's rounds: each service has a `nextAt`, 60s interval, ETag/304, doubling backoff to 15 min. Skipped while offline.                                                                                                                                                 |
| todo    | Jitter between services. Irrelevant with one; worth it before there are ten.                                                                                                                                                                                                                         |
| done    | Service rows in the panel (dot, name, level, incident or affected components); a row opens its status page.                                                                                                                                                                                          |
| done    | Services raise the popup (degraded, partial, major) with **View status page**; on hold and silent while offline.                                                                                                                                                                                     |
| partial | Services are built in (`DEFAULT_SERVICES`: GitHub). Cursor waits for a real capture of `status.cursor.com`; your own list waits for phase 3's settings panel.                                                                                                                                        |
| todo    | The tray icon recolors its dot to the worst level, including grey for offline. Icons swap only when the aggregate changes.                                                                                                                                                                           |

### Phase 2: tell me when it changes

| Status | Item                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| todo   | Popup state persisted to `state.json` (atomic write), so a relaunch mid-incident doesn't pop again for the incident you already dismissed. |
| todo   | Settle the history log format (see below) so nothing is lost before it's built.                                                            |

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

- **What does a Statuspage incident actually look like on the wire?** Every
  capture so far is all-green. The next time GitHub (or any Statuspage vendor)
  has an incident, save `/api/v2/summary.json` into `fixtures/statuspage/` and
  replace the synthetic variants in the adapter tests with it.

- **Should the probe endpoints be configurable?** Google and Microsoft see a
  request from your IP every 30 seconds while online (Windows already sends
  Microsoft's itself). A network that blocks both would read as permanently
  offline. Probably a settings entry in phase 3, defaulting to these two.

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
- **The probe endpoints' actual answers.** `PROBES` expects the documented
  responses (a 204 from `connectivitycheck.gstatic.com/generate_204`, a 200 with
  the body `Microsoft Connect Test` from `www.msftconnecttest.com/connecttest.txt`).
  The sandbox's network policy blocks both, so neither was observed. If one
  answers differently, a working network behind a dead other provider reads as
  "sign-in required". Check on a real machine that the row says connected.
- **Timer cadence while hidden.** Chromium, and so WebView2, throttles timers
  in a hidden page to roughly once a minute after it has been hidden for a few
  minutes. The panel is hidden nearly all day, so expect checks every ~60s
  rather than 30s, and "offline" to take up to two minutes to confirm when the
  OS doesn't report the drop itself. Fine for a connection check; if phase 1's
  poller needs tighter timing, the tick moves to Rust.
- **Proxies.** The probe client uses reqwest's `system-proxy` support. Whether
  that follows a Windows PAC file or a corporate proxy with authentication is
  unknown; if not, a proxied network reads as offline.
- **Captive portals.** Detection is unit tested against the shapes portals use
  (redirects, a login page where a 204 belonged) but has never met a real one.
- **The popup must not take focus.** `set_focusable(false)` before `show()`
  is `WS_EX_NOACTIVATE` on Windows, and tao then shows with `SW_SHOW`. Whether
  that combination leaves your keyboard where it was is the first thing to
  check on a real desktop: type into another app while pulling the network
  cable. macOS and Linux implement `set_focusable` differently again.
- **Clicking a non-activating window.** The popup's × and link have to work
  in a window that refuses activation. WebView2 should still deliver the
  clicks; nobody has tried it.
- **Resizing between modes.** The window is moved then resized when it
  switches between the 360×440 panel and the popup. On a mixed-DPI
  multi-monitor setup the logical-to-physical conversion is the part most
  likely to be off.
