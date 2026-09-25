//! Tray, window and native command wiring.
//!
//! The app is a background tray utility: no taskbar presence, and no visible
//! window until you ask for one. The webview owns what the panel says (see
//! `src/main.ts`); this side owns the shell around it, and makes the network
//! requests the webview's CSP deliberately can't.

mod probe;

use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime, WebviewWindow,
};

/// The window label, as declared in `tauri.conf.json`.
const PANEL: &str = "panel";

/// Holds the disabled status line at the top of the tray menu so the frontend
/// can keep it current.
struct StatusMenuItem(MenuItem<tauri::Wry>);

/// Update the tray's status line. Text is composed in the frontend; we apply it.
#[tauri::command]
fn set_tray_status(status: String, item: tauri::State<'_, StatusMenuItem>) -> Result<(), String> {
    item.0.set_text(status).map_err(|err| err.to_string())
}

/// Park the panel in the top-right corner of the best available display.
#[tauri::command]
fn position_panel(window: WebviewWindow) -> Result<(), String> {
    position_top_right(&window);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            set_tray_status,
            position_panel,
            probe::http_probe,
        ])
        .setup(|app| {
            app.manage(probe::ProbeClient::new()?);

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
                position_top_right(&window);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Show and focus the panel. Everything that shows it is a click the user just
/// made, so there is no attention request: flashing the taskbar for a window
/// someone asked for is nagging them about their own click.
fn show_panel<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(PANEL) else {
        return;
    };
    // Position before show: on a multi-monitor setup the window can otherwise
    // land on the small primary display instead of the largest screen.
    position_top_right(&window);
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle_panel<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(PANEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        show_panel(app);
    }
}

/// Inset from the monitor edge, in physical pixels.
const MARGIN: i32 = 24;

/// Anchor the window against the top-right corner of the best available display.
fn position_top_right<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(monitor) = target_monitor(window) else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };

    let (x, y) = top_right(*monitor.position(), *monitor.size(), size, MARGIN);
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
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

    const PANEL_SIZE: PhysicalSize<u32> = PhysicalSize {
        width: 360,
        height: 440,
    };

    #[test]
    fn sits_in_from_the_top_right_of_the_primary_display() {
        let at = top_right(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            PANEL_SIZE,
            MARGIN,
        );
        assert_eq!(at, (1920 - 360 - 24, 24));
    }

    #[test]
    fn honors_a_display_at_negative_coordinates() {
        let at = top_right(
            PhysicalPosition::new(-2560, -200),
            PhysicalSize::new(2560, 1440),
            PANEL_SIZE,
            MARGIN,
        );
        assert_eq!(at, (-360 - 24, -200 + 24));
    }

    #[test]
    fn never_starts_left_of_a_display_narrower_than_the_window() {
        let at = top_right(
            PhysicalPosition::new(100, 0),
            PhysicalSize::new(300, 800),
            PANEL_SIZE,
            MARGIN,
        );
        assert_eq!(at, (100, 24));
    }

    #[test]
    fn ranks_monitors_by_area() {
        assert!(
            monitor_pixel_area(&PhysicalSize::new(2560, 1440))
                > monitor_pixel_area(&PhysicalSize::new(1920, 1200))
        );
    }
}
