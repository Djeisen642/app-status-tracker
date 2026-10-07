# Future work

Everything we want built, in one place. The **MVP line** divides what has to
work before this is worth running daily from what can come later.

Status keys: **done** · **partial** · **todo**

---

## Phase 0: the scaffold

| Status | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done   | Tauri v2 + vanilla TypeScript + Vite, tooling copied from task-tracker: type-aware lint, Prettier, Vitest, Lefthook, Playwright.                                                                                                                                                                                                                                                                                                                              |
| done   | Derived versioning: `scripts/version.ts`, the `commit-msg` hook, `release.yml`. Starts at 0.1.0.                                                                                                                                                                                                                                                                                                                                                              |
| done   | CI: web gate, e2e with screenshots, and the full Rust gate (`fmt`, `clippy -D warnings`, `check`, `test`).                                                                                                                                                                                                                                                                                                                                                    |
| done   | Tray icon with a status line, **Show status** and **Quit**; left click toggles the panel.                                                                                                                                                                                                                                                                                                                                                                     |
| done   | Opaque, frameless panel that opens next to the tray icon that was clicked (parked top-right of the largest display until the first tray event, or on Linux where a click may never arrive); closes on Esc or ×.                                                                                                                                                                                                                                               |
| done   | The status model (`Level`, `worstLevel`) and the tray line (`formatTrayStatus`), tested.                                                                                                                                                                                                                                                                                                                                                                      |
| done   | **Internet connection check.** Plain-HTTP probes to Google's and Microsoft's connectivity endpoints, made from Rust (`probe.rs`, no redirects followed, 5s timeout, 1 KB body cap) and judged in `connectivity.ts`. Online if either answers correctly, captive portal if an answer is wrong or a redirect, offline after two failed rounds (or at once if the OS reports no network). Shown as the panel's first row and overriding the tray line.           |
| done   | **A popup when a check goes bad.** The window shrinks to a small card in the top-right corner, shown without taking focus, with a link to the page that explains it. Pops on a transition, closes itself on recovery (see phase 2: it now says the issue is resolved), stays dismissed until the next outage, doesn't pop over an open panel. Clicking it opens the panel. The internet check is the only check wired to it so far; services join in phase 1. |
| done   | Two icon masters, with the small one hand-tuned for 16–32px.                                                                                                                                                                                                                                                                                                                                                                                                  |

## Above the MVP line

### Phase 1: one adapter, end to end

| Status | Item                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done   | `fetch_status(url, etag)` in Rust: native TLS (see CLAUDE.md for why not rustls), system proxy, http(s) only, up to 5 redirects followed, 10s timeout, 2 MB cap. Tested against local sockets; a real HTTPS fetch through the sandbox proxy is an opt-in test (`cargo test -- --ignored`).                                                                                                                                |
| done   | Statuspage adapter over `/api/v2/summary.json`, tested against **real captures**: GitHub all-green, and **Cursor mid-incident** (a degraded component, indicator `minor`, an open `minor` incident naming it). `partial_outage`, `major_outage`, `under_maintenance` and the `major`/`critical` indicators are still documented vocabulary only; synthetic variants exercise them. Unrecognized values read as `unknown`. |
| done   | Polling rides the connection check's rounds: each service has a `nextAt`, 60s interval, ETag/304, doubling backoff to 15 min. Skipped while offline.                                                                                                                                                                                                                                                                      |
| todo   | Jitter between services. Irrelevant with one; worth it before there are ten.                                                                                                                                                                                                                                                                                                                                              |
| done   | Service rows in the panel (dot, name, level, incident or affected components); a row opens its status page.                                                                                                                                                                                                                                                                                                               |
| done   | Services raise the popup (degraded, partial, major) with **View status page**; on hold and silent while offline.                                                                                                                                                                                                                                                                                                          |
| done   | GitHub and Cursor are the first-launch list (`DEFAULT_SERVICES`); after that the list is `settings.json`, edited from the panel.                                                                                                                                                                                                                                                                                          |
| done   | The tray icon recolors its dot to the worst level: green/amber/red/grey, reusing the panel hero's tone (`headline().tone`, `summary.ts`) rather than a second colour rule — offline reads red like the hero does, not grey. Swaps only when the aggregate tone changes. Reviewed but never run against a real tray; see Known unknowns.                                                                                   |

### Phase 2: tell me when it changes

| Status | Item                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done   | **A resolved card when an issue ends.** `episodes.ts` remembers each service's trouble (first seen, worst level, the vendor's words) and closes it only on a good reading, never on a page that can't be read or a service that was removed; the popup shows the ending as a green card that stays until dismissed. In memory only; reviewed against the browser build, never run on a desktop. |
| todo   | Popup state **and the open episodes** persisted to `state.json` (atomic write), so a relaunch mid-incident doesn't pop again for the incident you already dismissed, and its ending is still announced (timed from the relaunch today).                                                                                                                                                         |
| todo   | Settle the history log format (see below) so nothing is lost before it's built. An `Episode` already is one row of it: service, start, peak, detail, and an end time that `resolution` has in hand when it closes.                                                                                                                                                                              |

### Phase 3: settings

| Status  | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| partial | **Add a service by pasting its address, checked before it's added.** Done for Statuspage: the address is normalized without the network, then `/api/v2/summary.json` must parse with the real adapter, and every refusal says why (unsupported, unreachable, server error, duplicate, not a web address). Still todo: the other probes (`/summary.json` for Instatus, RSS/Atom, a plain HTTP check), which need their own adapters and real captures first.                                        |
| done    | Remove a service (× on its row). The list persists to `settings.json`, written atomically and saved before memory changes; a broken file is repaired, not fatal.                                                                                                                                                                                                                                                                                                                                   |
| todo    | Component filters, picked from a live fetch. Required, not optional: GitHub's page covers Actions, Pages, Codespaces and Copilot, and a tracker that goes amber whenever Codespaces does gets muted within a week.                                                                                                                                                                                                                                                                                 |
| partial | **Settings overlay in the one window** (task-tracker's pattern): a gear icon in the appbar opens a sheet over the panel (`src/ui/settings.ts`), closed by its own × or Esc. So far it holds only build info (version, commit, build date — `src/lib/build-info.ts`, baked in by `vite.config.ts`'s `define`, no Tauri command needed). Still todo: moving the add-form and the future component picker in, and `parseSettings` repairs / `validateDraft` reports for whatever settings live there. |
| todo    | Launch at login.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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

- **What do a partial and a major outage look like on the wire?** The Cursor
  capture confirmed a minor incident. The next time a Statuspage vendor has a
  bigger one, save `/api/v2/summary.json` into `fixtures/statuspage/` and
  replace the remaining synthetic variants with it.
- **Should adding a page let you pick its components right away?** The check
  already has the component list in hand. Doing it in the add form would stop
  a page from ever being added in its noisiest form.
- **Which components should be watched by default?** The Cursor capture is the
  argument for component filters: an incident on Grok Bot alone makes
  "Cursor: degraded" pop up for everyone. Phase 3's picker is the real answer;
  until then, a sensible built-in default per service would cut the noise.

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
  events, anchoring the panel to the clicked tray icon on a multi-monitor
  mixed-DPI setup, the frameless opaque window, `skipTaskbar`, always-on-top.
  Windows is the platform to check first; macOS and Linux after.
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
- **A resolved card in the non-focusable popup.** It rides the same
  `prepare_popup` / `reveal_popup` path as an outage card, so the same unknowns
  apply (focus, first frame, clicks); nothing about it is new, and none of it
  has been run on a desktop.
- **Clicking a non-activating window.** The popup's × and link have to work
  in a window that refuses activation. WebView2 should still deliver the
  clicks; nobody has tried it.
- **Where `settings.json` lands.** Tauri's `app_config_dir()` for the
  identifier `com.jasonsuttles.app-status-tracker`: under `%APPDATA%` on
  Windows. Adding a page, quitting and relaunching is the check that it
  persists on a real desktop; the browser build's persistence is what e2e
  proves.
- **The popup's first frame.** It is sized while hidden, the page switches to
  popup mode, and it is shown 34ms later so it has painted. Whether a hidden
  WebView2 paints in that window, or the panel still flashes for a frame, is
  unverified.
- **Single instance on each platform.** `tauri-plugin-single-instance` hands
  a second launch to the first (a named mutex on Windows, D-Bus on Linux).
  Launch the app twice: there should be one tray icon, and the second launch
  should open the first one's panel.
- **Resizing between modes.** The window is moved then resized when it
  switches between the 360×440 panel and the popup. On a mixed-DPI
  multi-monitor setup the logical-to-physical conversion is the part most
  likely to be off.
- **The tray icon's recolor.** `set_tray_tone` calls `TrayIcon::set_icon` with
  one of four `include_image!`-embedded 32×32 PNGs (`icons/32x32{,-warn,-bad,-idle}.png`).
  It compiles, and the four PNGs were checked magnified at 32px in this
  sandbox, but nothing here can show a real system tray: whether Windows,
  AppIndicator (Linux) and macOS's menu bar all repaint on `set_icon` without
  a flash or a stale icon until the next OS repaint, and whether the dot
  still reads at whatever size each OS actually renders (Windows can shrink a
  32px tray icon further on high-DPI text scaling) needs a real desktop.
