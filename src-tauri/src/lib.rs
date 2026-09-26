//! Tray, window and native command wiring.
//!
//! The app is a background tray utility: no taskbar presence, and no visible
//! window until you ask for one. The webview owns what the panel says (see
//! `src/main.ts`); this side owns the shell around it, and makes the network
//! requests the webview's CSP deliberately can't.

mod fetch;
mod probe;
mod settings;
#[cfg(test)]
mod test_server;
mod web_url;
mod window;

use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager,
};

use window::{WindowMode, PANEL, PANEL_SIZE};

/// Holds the disabled status line at the top of the tray menu so the frontend
/// can keep it current.
struct StatusMenuItem(MenuItem<tauri::Wry>);

/// Update the tray's status line. Text is composed in the frontend; we apply it.
#[tauri::command]
fn set_tray_status(status: String, item: tauri::State<'_, StatusMenuItem>) -> Result<(), String> {
    item.0.set_text(status).map_err(|err| err.to_string())
}

/// The tray icon's dot colour: the same four tones the panel's hero and rows
/// use (`src/lib/summary.ts`'s `Tone`), so there is one decision about what
/// counts as good/warn/bad/idle, not two.
#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum TrayTone {
    Good,
    Warn,
    Bad,
    Idle,
}

/// Holds the built tray icon so its icon can be swapped after `setup` runs.
struct TrayHandle(TrayIcon<tauri::Wry>);

/// Recolor the tray icon's dot to the worst current level.
///
/// The four PNGs are the same `icon-small.svg` master with only the dot's fill
/// swapped (see `icons/README.md`); `include_image!` bakes each as raw pixels
/// into the binary at compile time, so recoloring never touches the
/// filesystem or pulls in a runtime image-decoding dependency.
#[tauri::command]
fn set_tray_tone(tone: TrayTone, tray: tauri::State<'_, TrayHandle>) -> Result<(), String> {
    let icon = match tone {
        TrayTone::Good => tauri::include_image!("icons/32x32.png"),
        TrayTone::Warn => tauri::include_image!("icons/32x32-warn.png"),
        TrayTone::Bad => tauri::include_image!("icons/32x32-bad.png"),
        TrayTone::Idle => tauri::include_image!("icons/32x32-idle.png"),
    };
    tray.0.set_icon(Some(icon)).map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // First, per the plugin's docs: a second launch must hand off before any
    // other plugin or window starts. It shows this copy's panel, which is what
    // someone launching the app again is looking for.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        window::show_panel(app);
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            set_tray_status,
            set_tray_tone,
            window::prepare_popup,
            window::reveal_popup,
            window::present_panel,
            web_url::open_url,
            probe::http_probe,
            fetch::fetch_status,
            settings::settings_load,
            settings::settings_save,
        ])
        .setup(|app| {
            app.manage(probe::ProbeClient::new()?);
            app.manage(fetch::FetchClient::new()?);
            app.manage(WindowMode::new());

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
                    "show" => window::show_panel(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        window::toggle_panel(tray.app_handle());
                    }
                });

            // `generate_context!` embeds the icon set at compile time, so it is
            // committed and always present here. Still handled as an Option
            // rather than unwrapped: a missing tray icon is a cosmetic problem,
            // and panicking in `setup` takes the whole app down with it.
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            let tray = tray.build(app)?;
            app.manage(TrayHandle(tray));

            // Declared hidden in tauri.conf.json. Top-right, because top-left
            // belongs to task-tracker's check-in card and bottom-right to
            // noticeable-calendar-alert: two utilities in one corner means
            // ignoring both.
            if let Some(window) = app.get_webview_window(PANEL) {
                window::place_top_right(&window, PANEL_SIZE);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
