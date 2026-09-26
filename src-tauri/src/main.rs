// Prevents an extra console window on Windows in release builds — this is a
// background tray utility, not a console app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_status_tracker_lib::run()
}
