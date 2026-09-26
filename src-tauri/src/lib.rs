//! Tray, window and native command wiring.
//!
//! The app is a background tray utility: no taskbar presence, and no visible
//! window until you ask for one. The webview owns what the panel says (see
//! `src/main.ts`); this side owns the shell around it, and makes the network
//! requests the webview's CSP deliberately can't.

mod fetch;
mod probe;
mod settings;

use std::sync::Mutex;

use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, Runtime, WebviewWindow,
};
use tauri_plugin_opener::OpenerExt;

/// The window label, as declared in `tauri.conf.json`.
const PANEL: &str = "panel";

/// The panel's size, in logical pixels. Matches `tauri.conf.json`.
const PANEL_SIZE: LogicalSize<f64> = LogicalSize {
    width: 360.0,
    height: 440.0,
};

/// The popup is the panel's width and only as tall as what it says.
const POPUP_MIN_HEIGHT: f64 = 72.0;

/// What the one window is being used as.
///
/// A second window for the popup would need its own capability set and its own
/// positioning, and would be one more thing on screen. Instead the same window
/// shrinks to the popup and grows back into the panel.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Panel,
    Popup,
}

struct WindowMode(Mutex<Mode>);

impl WindowMode {
    fn get(&self) -> Mode {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn set(&self, mode: Mode) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = mode;
    }
}

/// Holds the disabled status line at the top of the tray menu so the frontend
/// can keep it current.
struct StatusMenuItem(MenuItem<tauri::Wry>);

/// Update the tray's status line. Text is composed in the frontend; we apply it.
#[tauri::command]
fn set_tray_status(status: String, item: tauri::State<'_, StatusMenuItem>) -> Result<(), String> {
    item.0.set_text(status).map_err(|err| err.to_string())
}

/// Show the popup, `height` logical pixels tall, *without* taking focus.
///
/// Returns `false`, and changes nothing, when the panel is already open: it
/// says the same thing, and shrinking it into a popup under the user's cursor
/// would be worse than not popping up at all.
#[tauri::command]
fn present_popup(
    window: WebviewWindow,
    height: f64,
    mode: tauri::State<'_, WindowMode>,
) -> Result<bool, String> {
    if window.is_visible().unwrap_or(false) && mode.get() == Mode::Panel {
        return Ok(false);
    }
    mode.set(Mode::Popup);

    // Not focusable *before* it is shown: on Windows this is WS_EX_NOACTIVATE,
    // so the popup appears over whatever you are typing into without taking the
    // keyboard from it. It arrives unbidden from a timer; stealing focus there
    // would turn a status notice into lost keystrokes.
    // Ignored on failure: a popup that might take focus beats no popup at all.
    let _ = window.set_focusable(false);
    let height = height.clamp(POPUP_MIN_HEIGHT, PANEL_SIZE.height);
    place_top_right(&window, LogicalSize::new(PANEL_SIZE.width, height));
    window.show().map_err(|err| err.to_string())?;
    Ok(true)
}

/// Grow the window into the full panel and focus it: the popup was clicked.
#[tauri::command]
fn present_panel(app: AppHandle) {
    show_panel(&app);
}

/// Open a status page (or a captive portal's sign-in page) in the browser.
///
/// The URL came off the network, so this is where it is held to http(s): no
/// `file:`, no custom protocol handlers, nothing else the OS would launch. The
/// opener plugin is driven from here, not from JavaScript, so it needs no
/// capability scope at all.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = parse_web_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|err| err.to_string())
}

fn parse_web_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|err| format!("Not a URL: {err}"))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        "http" | "https" => Err("The URL has no host.".to_owned()),
        other => Err(format!("Only web pages can be opened, not {other}:// URLs")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            set_tray_status,
            present_popup,
            present_panel,
            open_url,
            probe::http_probe,
            fetch::fetch_status,
            settings::settings_load,
            settings::settings_save,
        ])
        .setup(|app| {
            app.manage(probe::ProbeClient::new()?);
            app.manage(fetch::FetchClient::new()?);
            app.manage(WindowMode(Mutex::new(Mode::Panel)));

            // On macOS this is a menu-bar-only utility: keep it out of the Dock
            // and the app switcher by running as an Accessory app.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // --- System tray ---------------------------------------------------
            let status_item =
                MenuItem::with_id(app, "status", "No services yet", false, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            // Also the only way in on Linux, where most panels never deliver the
            // icon's own click event.
            let show_item = MenuItem::with_id(app, "show", "Show status", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &status_item as &dyn IsMenuItem<tauri::Wry>,
                    &separator,
                    &show_item,
                    &quit_item,
                ],
            )?;

            app.manage(StatusMenuItem(status_item.clone()));

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("App Status Tracker")
                .menu(&menu)
                // Left click is the panel; the menu lives on right click.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => show_panel(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle());
                    }
                });

            // `generate_context!` embeds the icon set at compile time, so it is
            // committed and always present here. Still handled as an Option
            // rather than unwrapped: a missing tray icon is a cosmetic problem,
            // and panicking in `setup` takes the whole app down with it.
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray.build(app)?;

            // Declared hidden in tauri.conf.json. Top-right, because top-left
            // belongs to task-tracker's check-in card and bottom-right to
            // noticeable-calendar-alert: two utilities in one corner means
            // ignoring both.
            if let Some(window) = app.get_webview_window(PANEL) {
                place_top_right(&window, PANEL_SIZE);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Show and focus the panel. Everything that shows it is a click the user just
/// made, so there is no attention request: flashing the taskbar for a window
/// someone asked for is nagging them about their own click.
///
/// Also how a showing popup becomes the panel: the window is made focusable
/// again, grown back to full size, and the webview told to switch what it draws.
fn show_panel<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(PANEL) else {
        return;
    };
    app.state::<WindowMode>().set(Mode::Panel);
    let _ = app.emit("show-panel", ());
    let _ = window.set_focusable(true);
    // Position before show: on a multi-monitor setup the window can otherwise
    // land on the small primary display instead of the largest screen.
    place_top_right(&window, PANEL_SIZE);
    let _ = window.show();
    let _ = window.set_focus();
}

/// A tray click closes the panel if it is open, and otherwise opens it,
/// including over a showing popup, which it replaces.
fn toggle_panel<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(PANEL) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible && app.state::<WindowMode>().get() == Mode::Panel {
        let _ = window.hide();
    } else {
        show_panel(app);
    }
}

/// Inset from the monitor edge, in physical pixels.
const MARGIN: i32 = 24;

/// Size the window and anchor it against the top-right corner of the best
/// available display.
///
/// The corner is computed from the size being *set*, not read back from the
/// window: a resize isn't guaranteed to have landed by the next call, and a
/// stale width would park a shrinking popup short of the corner. Moved first,
/// then sized, so a logical size is scaled by the target display's DPI rather
/// than the one the window is leaving.
fn place_top_right<R: Runtime>(window: &WebviewWindow<R>, size: LogicalSize<f64>) {
    let Some(monitor) = target_monitor(window) else {
        let _ = window.set_size(size);
        return;
    };

    let physical = size.to_physical::<u32>(monitor.scale_factor());
    let (x, y) = top_right(*monitor.position(), *monitor.size(), physical, MARGIN);
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = window.set_size(size);
}

/// Where the window's top-left corner goes to sit `margin` in from the
/// monitor's top-right corner.
///
/// Offset by the monitor's own origin: displays left of or above the primary
/// sit at negative coordinates, and ignoring that puts the window off-screen.
fn top_right(
    origin: tauri::PhysicalPosition<i32>,
    monitor: tauri::PhysicalSize<u32>,
    window: tauri::PhysicalSize<u32>,
    margin: i32,
) -> (i32, i32) {
    let monitor_width = i32::try_from(monitor.width).unwrap_or(i32::MAX);
    let window_width = i32::try_from(window.width).unwrap_or(0);
    // Never further left than the monitor's own edge, even on a display
    // narrower than the window.
    let x = (origin.x + monitor_width - window_width - margin).max(origin.x);
    (x, origin.y + margin)
}

/// Largest display first (often the external monitor), then the OS primary
/// ("main" monitor), then whatever display currently owns the window.
fn target_monitor<R: Runtime>(window: &WebviewWindow<R>) -> Option<tauri::Monitor> {
    largest_monitor(window)
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
}

/// Pick the connected monitor with the greatest pixel area (width × height).
///
/// On a tie, `max_by_key` returns the *last* maximal element, so which one wins
/// depends on OS enumeration order. Harmless: "largest" is ambiguous then.
fn largest_monitor<R: Runtime>(window: &WebviewWindow<R>) -> Option<tauri::Monitor> {
    let monitors = window.available_monitors().ok()?;
    monitors
        .into_iter()
        .max_by_key(|monitor| monitor_pixel_area(monitor.size()))
}

fn monitor_pixel_area(size: &tauri::PhysicalSize<u32>) -> u64 {
    u64::from(size.width) * u64::from(size.height)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{PhysicalPosition, PhysicalSize};

    const WINDOW: PhysicalSize<u32> = PhysicalSize {
        width: 360,
        height: 440,
    };

    #[test]
    fn sits_in_from_the_top_right_of_the_primary_display() {
        let at = top_right(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            WINDOW,
            MARGIN,
        );
        assert_eq!(at, (1920 - 360 - 24, 24));
    }

    #[test]
    fn honors_a_display_at_negative_coordinates() {
        let at = top_right(
            PhysicalPosition::new(-2560, -200),
            PhysicalSize::new(2560, 1440),
            WINDOW,
            MARGIN,
        );
        assert_eq!(at, (-360 - 24, -200 + 24));
    }

    #[test]
    fn never_starts_left_of_a_display_narrower_than_the_window() {
        let at = top_right(
            PhysicalPosition::new(100, 0),
            PhysicalSize::new(300, 800),
            WINDOW,
            MARGIN,
        );
        assert_eq!(at, (100, 24));
    }

    #[test]
    fn opens_only_web_pages() {
        assert!(parse_web_url("https://www.githubstatus.com/").is_ok());
        assert!(parse_web_url("http://login.hotel/start").is_ok());
        assert!(parse_web_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(parse_web_url("javascript:alert(1)").is_err());
        assert!(parse_web_url("ms-settings:network").is_err());
        assert!(parse_web_url("not a url").is_err());
    }

    #[test]
    fn ranks_monitors_by_area() {
        assert!(
            monitor_pixel_area(&PhysicalSize::new(2560, 1440))
                > monitor_pixel_area(&PhysicalSize::new(1920, 1200))
        );
    }
}
