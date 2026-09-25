# CLAUDE.md

Guidance for working in this repository. Read this before making changes.

## What this is

**App Status Tracker**: a lightweight system-tray utility (Windows tray, macOS
menu bar, Linux panel) that watches vendor status pages (GitHub, Cursor, AWS,
whatever you run on) and turns them into one tray icon. Green when everything is
fine, the worst current state when it isn't, and a notification only when
something _changes_. Clicking the icon opens a small panel listing each service.

It is a sibling of `task-tracker` and inherits its stack, tooling and quality
bar. When in doubt about a convention, that repo's `CLAUDE.md` is the precedent.

**Stack (deliberate):** Tauri v2 + Vanilla TypeScript + Vite. **No React, no UI
framework**: the app runs all day, so idle memory matters. Do not introduce a
framework.

The plan, phase by phase, with the MVP line, is `docs/future-work.md`.

## The quality bar (definition of done)

A change is **not done** until all of the following are true. Do not report
something as finished or "working" unless you have run these and seen them pass.

1. **`pnpm run check` passes**: format, lint (type-aware), `tsc --noEmit`,
   version agreement, and the unit tests.
2. **`pnpm run build` passes.** A green lint/test run does **not** prove the app
   bundles.
3. **New logic has a unit test.** Pure logic lives in `src/lib/*.ts` and is
   tested in a sibling `*.test.ts`. Bugs get a regression test.
4. **Adapters are tested against real responses.** Every status-page adapter has
   fixtures captured from the live page, including one taken _during an
   incident_; an all-green fixture exercises almost none of the parser. Never
   hand-write a fixture from memory of what an API "usually" returns.
5. **`pnpm run e2e` passes**, and you have **looked at `docs/screenshots/`**.
   Invoke the `verify-app` skill. If _every_ spec fails in ~3ms, that is a
   missing browser, not your change: point Playwright at the one that is there
   with `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-<ver>/chrome-linux/chrome`
   (`ls /opt/pw-browsers`). Never run Playwright's browser installer here.
6. **Rust changes pass the Rust gate.** In `src-tauri`: `cargo fmt --check`,
   `cargo clippy --all-targets -- -D warnings`, `cargo check`, `cargo test`. All
   four run in CI and all four work in this sandbox once the system libraries
   are installed (below), so run them; don't defer to CI.
7. **Adversarial self-review before declaring victory.** Re-read your own diff
   hunting for the bug that breaks the _app_, not the lint nit.
8. **If the change moves something across the MVP line, update
   `docs/future-work.md` and `README.md`.** Nothing fails when they drift, so
   they drift silently, and always toward claiming shipped work doesn't exist.
   Check the README's tray-menu list against the menu actually built in
   `src-tauri/src/lib.rs`.

### Verify, don't assume

- **Never trust training-cutoff memory for versions, API surfaces or status
  page endpoints.** Check the live registry (`npm view <pkg> version`),
  installed type defs, release pages, and the actual status page.
- **Newest is not always correct; check peer ranges.** TypeScript is pinned to
  `~6.0.3` because `typescript-eslint` declares `typescript: ">=4.8.4 <6.1.0"`.
  Bumping past that silently disables type-aware linting.
- **Respect pnpm's minimum release age.** If an install adds entries to
  `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, the version you asked for
  is too fresh. Pick an older one; don't commit the exclusion. (Vitest is on 4
  for exactly this reason.)
- **Distinguish "reviewed-correct" from "verified-running."** Say which one you
  mean. Don't claim a desktop behavior works if you only reasoned about it.

## Architecture

```
src/
  main.ts               # PanelController: connection check loop, Internet row, tray line
  styles.css            # Opaque panel; light/dark tokens
  lib/
    status.ts(.test)    # Level: the normalized status model, worstLevel
    connectivity.ts(.test)  # The internet check: probes, verdicts, offline hysteresis
    time.ts             # Millisecond constants
    tray.ts(.test)      # The tray's status line
    errors.ts(.test)    # describeError() for native dialogs
    tauri.ts            # Optional native bridge; degrades gracefully in a browser
src-tauri/
  src/lib.rs            # Tray, panel window, top-right positioning
  src/probe.rs          # http_probe: one plain-HTTP GET, reported as it came back
  src/main.rs           # Binary entry point
  tauri.conf.json       # Opaque, frameless, alwaysOnTop, skipTaskbar, hidden-until-clicked
  capabilities/         # Least-privilege permission set
e2e/
  harness.ts            # startApp(): frozen clock, empty storage
  panel.spec.ts         # The panel, driven in a real browser
  connectivity.spec.ts  # The connection check, with the network routed by Playwright
  capture.spec.ts       # Screenshots into docs/screenshots/, light and dark
scripts/
  version.ts(.test)     # The version, derived from the commit subjects
  commit-msg.ts         # The hook that holds a subject to that grammar
docs/
  future-work.md        # The plan, the MVP line, known unknowns
  screenshots/          # Regenerated by `pnpm run e2e -- capture`
.claude/skills/
  verify-app/           # How to run and look at the app
```

### Key design decisions (don't regress these)

- **Rust does the HTTP; TypeScript does everything else.** Status pages are
  fetched by an app-defined Rust command (phase 1). The webview's CSP is
  `connect-src 'self' ipc:`, most status APIs send no CORS headers, and
  `tauri-plugin-http` needs a URL scope that fails silently, and only on a real
  desktop run, when it's wrong. Rust returns `{ status, etag, body }`; parsing,
  normalizing and deciding what changed are pure TypeScript in `src/lib/`, where
  Vitest can reach them. Don't move parsing into Rust and don't widen the CSP.
- **The connection is checked on its own, and everything defers to it.** A
  vendor can't be judged while the machine is offline, so `connectivity.ts`
  decides first and the tray line says "Offline" instead of naming services.
  Three rules there were each chosen against a specific failure:
  - **Two providers, online if either answers.** One of them having a bad day
    must not read as the whole internet being down.
  - **Plain HTTP, redirects not followed, fixed expected answers.** That is the
    only way to see a captive portal. Don't "upgrade" the probes to HTTPS: a
    portal then looks like a plain failure, and "sign in to the Wi-Fi" (which
    you can act on) becomes "offline" (which you can't).
  - **Offline after two failed rounds, back online after one success.** One
    dropped round is a Wi-Fi roam, and a status that flickers on those gets
    ignored. `navigator.onLine === false` skips the wait, because that reading
    (no interface up at all) is the one it gets right; `true` proves nothing.
    The probe client has **no TLS backend** (`reqwest` with default features
    off). Phase 1 needs one for status pages and chooses it then; the default,
    aws-lc-rs, is a C build nobody has tried on Windows here yet.
- **`unknown` is the worst level, never a quiet green.** A failed fetch means
  the app is blind. `LEVELS` orders `unknown` above `major` on purpose, and
  nothing may map a failure to `operational`. A status tracker that shows green
  while it can't see is worse than none.
- **Checks are a chain of timeouts, never an interval.** The connection check
  schedules its next run when the current one finishes, so after the machine
  sleeps one pending timeout fires on wake instead of a backlog. It also reruns
  at once on the window's `online`/`offline` events.
- **Polling will be slot-like, not a timer per service.** A 30s tick asks which
  services are _due_ (task-tracker's slot lesson): after the lid has been shut
  for three hours, each service is fetched once, not in a burst of queued
  timers. Never replace it with `setInterval` per service.
- **Notify on transitions, and persist what you've already said.** Phase 2
  keys notifications on `(service, incidentId, level)` and writes last-known
  state atomically. Without that, every relaunch during a long incident
  re-notifies. This mirrors task-tracker's persisted `last_check_in`.
- **The panel is opaque, deliberately.** Transparency on macOS needs
  `app.macOSPrivateApi` in `tauri.conf.json` _and_ the `macos-private-api` Cargo
  feature, fails silently with only one, and rules out the Mac App Store. A list
  of statuses doesn't need to float. Don't add transparency back without both
  halves and a reason.
- **Top-right, because the other corners are taken.** Top-left is task-tracker's
  check-in card; bottom-right is noticeable-calendar-alert. Two utilities in one
  corner means ignoring both.
- **Showing the panel never requests attention.** Every way to open it is a
  click the user just made. Status changes go to native notifications (phase 2),
  not to a window that steals focus: nobody types into an outage.
- **The panel does not hide on blur (yet).** Clicking the tray icon blurs the
  panel before the click arrives, so a naive hide-on-blur turns "click to close"
  into "click to reopen". It needs a debounce and a real desktop to test on.
- **Settings will be an overlay in the one window, not a second window**, as in
  task-tracker: a second window needs its own capability set and positioning.
- **The frontend must run framework-free in a plain browser too.** Every native
  call in `tauri.ts` is guarded by `isTauri()` and degrades to a no-op or a
  browser equivalent. This keeps `pnpm run dev` a fast loop with no Rust build,
  and it is what lets e2e drive the real controller.
- **Link the stylesheet from `index.html`; never `import './styles.css'`.** A JS
  CSS import injects a `<style>` tag in dev, which the `style-src 'self'` CSP
  blocks. That breaks only in the desktop webview, never in lint, tests, or a
  browser.
- **Giving an element a `display` also overrides `[hidden]`.** `styles.css`
  restores `[hidden] { display: none !important }` globally. Keep it: without
  it a `hidden` flex container stays on screen, and in task-tracker that was a
  settings panel covering the whole app on launch.
- **Security: status page content is untrusted.** Service names, component
  names and incident text come off the network. Render with `textContent`, never
  `innerHTML`, and open links through a Rust command rather than the scoped
  opener plugin.
- **Tauri permissions need a _scope_, not just the permission.** A bare
  capability string for a scoped plugin (opener, fs, http) enables the command
  with an empty allowlist, and every call is denied at runtime, only on a real
  desktop. This app avoids the problem by doing network and opener work in
  app-defined Rust commands, which don't pass through the capability system.
- **Surface native-side failures in a dialog, not `console.error`.** Polling
  fires while the window is hidden. Route user-facing errors through
  `showError()`.
- **Motion is GPU-only.** Animate `transform`/`opacity` exclusively, and respect
  `prefers-reduced-motion`.
- **The version is derived from the commit subjects and lives in four files.**
  `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the
  crate's entry in `src-tauri/Cargo.lock`. `scripts/version.ts` is the single
  writer; `pnpm run version:check` is part of `pnpm run check`. `feat`/`fix`/
  `perf` move the number, nothing else does, and the `commit-msg` hook enforces
  the grammar. 1.0 is set by hand: below it, a breaking change bumps the minor.

### Borrowed scars

From task-tracker and noticeable-calendar-alert, applied here. Don't undo them.

- **Two icon masters.** Downscaling detailed art to 32px produces a smudge in
  the tray. `icon-small.svg` exists for ≤32px. `.ico`/`.icns` must be listed in
  `bundle.icon`, and `tauri icon` overwrites the hand-tuned sizes every time it
  runs. See `src-tauri/icons/README.md`.
- **A status line refreshed only on events is a stale snapshot.** Once polling
  exists, the tray line re-renders on the tick and pushes only when it changed.
- **A flag set after an `await` is not a guard.** Raise it synchronously, before
  the first `await`. `checking` in `main.ts` is the live example.
- **Size the window to its content.** 360×440 today; revisit when rows exist.
- **Don't assume an input is sorted.** `formatTrayStatus` orders by severity
  itself rather than trusting the caller.

## Commands

**The package manager is pnpm**, pinned by `packageManager` in `package.json`.
On a fresh container it may not be on PATH; `corepack enable && corepack prepare
pnpm@<pinned> --activate` installs exactly the pinned version. Don't use
`npm install`: it would write a `package-lock.json` alongside `pnpm-lock.yaml`.
(`npm view` is fine; that's a registry query.)

`pnpm-workspace.yaml` records the build-script decision per package under
`allowBuilds`, so the expected skips are silent and a new one stands out.

| Command                  | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `pnpm install`           | Install deps + git hooks (`prepare` → lefthook) |
| `pnpm run dev`           | Browser-only preview of the panel (port 1440)   |
| `pnpm run tauri dev`     | Full desktop app (needs Rust + Tauri prereqs)   |
| `pnpm run check`         | format + lint + typecheck + version + test      |
| `pnpm run build`         | `tsc --noEmit` + `vite build`                   |
| `pnpm run e2e`           | Playwright, plus screenshots                    |
| `pnpm run version:check` | Do the four files carrying the version agree?   |
| `pnpm run version:next`  | The version the commits since the last tag earn |
| `pnpm run version:sync`  | Write a version into all four of those files    |

Git hooks (Lefthook) auto-run eslint `--fix`, prettier, and project `tsc` on
staged files at commit time, and hold the commit subject to Conventional
Commits.

## TypeScript conventions

- `verbatimModuleSyntax` is on → use `import type { … }` for type-only imports.
- Imports use explicit `.ts` extensions (`./lib/status.ts`).
- `@typescript-eslint/no-floating-promises` is an error → `void` deliberate
  fire-and-forget promises.
- Unused args/vars must be `_`-prefixed.
- The config is strict. Don't loosen it to dodge an error.
- `restrict-template-expressions` is on: wrap numbers in `String(…)` inside
  template literals.

## What CANNOT be verified in the agent sandbox

The Rust **does** compile here, once the system libraries are installed. A fresh
container doesn't have them, and the failure reads like a broken crate
(`The system library gdk-3.0 required by crate gdk-sys was not found`):

```bash
apt-get update    # REQUIRED FIRST: a stale index 404s on every package below
apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev pkg-config
```

(`librsvg2-bin` adds `rsvg-convert`, for regenerating icons.)

The sandbox's network policy may also block the status pages themselves, and
it blocks the connectivity probe endpoints. e2e routes every probe through
Playwright (`setNetwork` in the harness) for that reason; never let a spec
depend on the real network. If a
fixture can't be captured, say so and ask for it; don't fabricate one.

What this environment lacks is a **desktop webview and any real desktop
machine**. Nothing native in this app has been run yet on any platform: the
tray, its click, the menu, positioning and the frameless window are all
_reviewed for correctness but never executed_. The list is under "Known
unknowns" in `docs/future-work.md`. When you touch any of it, say explicitly in
your summary that it is reviewed-but-unrun, and list what must be checked
on-device.
