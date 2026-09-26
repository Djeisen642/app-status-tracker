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
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
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

            tray.build(app)?;

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
