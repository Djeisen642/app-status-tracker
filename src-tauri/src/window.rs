//! The one window and its two modes: the panel, and the popup it shrinks to.
//!
//! The panel opens next to the tray icon that was clicked, like a native
//! flyout. The popup instead always sits in the top-right corner of the
//! largest display, because it arrives unbidden from a timer rather than a
//! click, and top-left is task-tracker's card, bottom-right is
//! noticeable-calendar-alert's: two utilities landing on the same corner
//! means ignoring both.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, LogicalSize, Manager, Runtime, WebviewWindow};

/// The window label, as declared in `tauri.conf.json`.
pub const PANEL: &str = "panel";

/// The panel's size, in logical pixels. Matches `tauri.conf.json`.
pub const PANEL_SIZE: LogicalSize<f64> = LogicalSize {
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
pub enum Mode {
    Panel,
    Popup,
}

pub struct WindowMode(Mutex<Mode>);

impl WindowMode {
    pub fn new() -> Self {
        Self(Mutex::new(Mode::Panel))
    }

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

/// The tray icon's last known on-screen rect, refreshed on every tray event.
/// `show_panel` reads it to open next to the icon that was actually clicked,
/// instead of a fixed screen corner. `None` before the first tray event (e.g.
/// a relaunch handed off by `tauri-plugin-single-instance`), or on Linux
/// panels that never deliver one at all.
pub struct TrayAnchor(Mutex<Option<tauri::Rect>>);

impl TrayAnchor {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn set(&self, rect: tauri::Rect) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(rect);
    }

    fn get(&self) -> Option<tauri::Rect> {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Size the window for the popup, `height` logical pixels tall, but don't
/// show it yet: `reveal_popup` does, once the webview has drawn the popup.
/// Showing in the same step displayed the panel's last frame at popup size
/// for a moment, which an adversarial review caught.
///
/// Returns `false`, and changes nothing, when the panel is already open: it
/// says the same thing, and shrinking it into a popup under the user's cursor
/// would be worse than not popping up at all.
#[tauri::command]
pub fn prepare_popup(
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
    Ok(true)
}

/// Show the prepared popup, without focus. A no-op if a tray click turned the
/// window back into the panel in the meantime: that path has shown it already.
#[tauri::command]
pub fn reveal_popup(
    window: WebviewWindow,
    mode: tauri::State<'_, WindowMode>,
) -> Result<(), String> {
    if mode.get() != Mode::Popup {
        return Ok(());
    }
    window.show().map_err(|err| err.to_string())
}

/// Grow the window into the full panel and focus it: the popup was clicked.
#[tauri::command]
pub fn present_panel(app: AppHandle) {
    show_panel(&app);
}

/// Show and focus the panel. Everything that shows it is a click the user just
/// made, so there is no attention request: flashing the taskbar for a window
/// someone asked for is nagging them about their own click.
///
/// Also how a showing popup becomes the panel: the window is made focusable
/// again, grown back to full size, and the webview told to switch what it draws.
pub fn show_panel<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(PANEL) else {
        return;
    };
    app.state::<WindowMode>().set(Mode::Panel);
    let _ = app.emit("show-panel", ());
    let _ = window.set_focusable(true);
    // Position before show, so it never flashes at the old spot first.
    match app.state::<TrayAnchor>().get() {
        Some(icon) => place_near_tray(&window, PANEL_SIZE, icon),
        // No known icon rect yet (first launch handed off, or a Linux panel
        // that never sends one): fall back to the old fixed corner rather
        // than guessing.
        None => place_top_right(&window, PANEL_SIZE),
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// A tray click closes the panel if it is open, and otherwise opens it,
/// including over a showing popup, which it replaces.
pub fn toggle_panel<R: Runtime>(app: &AppHandle<R>) {
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

/// Size the window and anchor it next to the tray icon that opened it: above
/// the icon when it sits in a monitor's bottom half (Windows and most Linux
/// taskbars), below it otherwise (a macOS menu bar). Horizontally centered on
/// the icon, and clamped so the window never lands off-screen.
///
/// If the icon's rect doesn't land on any currently connected monitor (a
/// stale rect from before a display was unplugged), falls back to
/// `target_monitor`'s largest-then-primary-then-current search, same as
/// `place_top_right` uses.
pub fn place_near_tray<R: Runtime>(
    window: &WebviewWindow<R>,
    size: LogicalSize<f64>,
    icon: tauri::Rect,
) {
    // Tray icon rects come from the OS shell, already in physical pixels, so
    // `to_physical` on them is a plain cast: the scale factor here is unused
    // whenever the value is the `Physical` variant, which is what every
    // platform's tray actually reports.
    let icon_position = icon.position.to_physical::<i32>(1.0);
    let icon_size = icon.size.to_physical::<u32>(1.0);

    let Some(monitor) =
        monitor_containing(window, icon_position).or_else(|| target_monitor(window))
    else {
        let _ = window.set_size(size);
        return;
    };

    let physical = size.to_physical::<u32>(monitor.scale_factor());
    let (x, y) = anchor_to_icon(
        *monitor.position(),
        *monitor.size(),
        icon_position,
        icon_size,
        physical,
        MARGIN,
    );
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = window.set_size(size);
}

/// Where the window's top-left corner goes to sit next to a tray icon: above
/// it if the icon is in the monitor's bottom half, below it otherwise, and
/// never past either edge of the monitor.
fn anchor_to_icon(
    monitor_origin: tauri::PhysicalPosition<i32>,
    monitor_size: tauri::PhysicalSize<u32>,
    icon_position: tauri::PhysicalPosition<i32>,
    icon_size: tauri::PhysicalSize<u32>,
    window: tauri::PhysicalSize<u32>,
    margin: i32,
) -> (i32, i32) {
    let monitor_width = i32::try_from(monitor_size.width).unwrap_or(i32::MAX);
    let monitor_height = i32::try_from(monitor_size.height).unwrap_or(i32::MAX);
    let window_width = i32::try_from(window.width).unwrap_or(0);
    let window_height = i32::try_from(window.height).unwrap_or(0);
    let icon_width = i32::try_from(icon_size.width).unwrap_or(0);
    let icon_height = i32::try_from(icon_size.height).unwrap_or(0);

    let min_y = monitor_origin.y;
    let max_y = (monitor_origin.y + monitor_height - window_height).max(min_y);
    let icon_mid_y = icon_position.y - monitor_origin.y + icon_height / 2;
    let y = if icon_mid_y > monitor_height / 2 {
        icon_position.y - window_height - margin
    } else {
        icon_position.y + icon_height + margin
    }
    .max(min_y)
    .min(max_y);

    let min_x = monitor_origin.x;
    let max_x = (monitor_origin.x + monitor_width - window_width).max(min_x);
    let icon_mid_x = icon_position.x + icon_width / 2;
    let x = (icon_mid_x - window_width / 2).max(min_x).min(max_x);

    (x, y)
}

/// The connected monitor whose bounds contain this physical point, if any.
fn monitor_containing<R: Runtime>(
    window: &WebviewWindow<R>,
    point: tauri::PhysicalPosition<i32>,
) -> Option<tauri::Monitor> {
    let monitors = window.available_monitors().ok()?;
    monitors.into_iter().find(|monitor| {
        let origin = *monitor.position();
        let size = *monitor.size();
        let width = i32::try_from(size.width).unwrap_or(0);
        let height = i32::try_from(size.height).unwrap_or(0);
        point.x >= origin.x
            && point.x < origin.x + width
            && point.y >= origin.y
            && point.y < origin.y + height
    })
}

/// Size the window and anchor it against the top-right corner of the best
/// available display. Used for the popup, which arrives from a timer with no
/// click to anchor to, and as `show_panel`'s fallback before any tray icon
/// rect is known.
///
/// The corner is computed from the size being *set*, not read back from the
/// window: a resize isn't guaranteed to have landed by the next call, and a
/// stale width would park a shrinking popup short of the corner. Moved first,
/// then sized, so a logical size is scaled by the target display's DPI rather
/// than the one the window is leaving.
pub fn place_top_right<R: Runtime>(window: &WebviewWindow<R>, size: LogicalSize<f64>) {
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
    fn ranks_monitors_by_area() {
        assert!(
            monitor_pixel_area(&PhysicalSize::new(2560, 1440))
                > monitor_pixel_area(&PhysicalSize::new(1920, 1200))
        );
    }

    #[test]
    fn opens_above_a_tray_icon_on_a_bottom_taskbar() {
        // A Windows tray icon, bottom-right of a 1920x1080 primary display.
        let at = anchor_to_icon(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            PhysicalPosition::new(1870, 1050),
            PhysicalSize::new(24, 24),
            WINDOW,
            MARGIN,
        );
        assert_eq!(at, (1920 - 360, 1050 - 440 - 24));
    }

    #[test]
    fn opens_below_a_tray_icon_on_a_top_menu_bar() {
        // A macOS menu bar icon near the top of the display.
        let at = anchor_to_icon(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            PhysicalPosition::new(1200, 0),
            PhysicalSize::new(24, 22),
            WINDOW,
            MARGIN,
        );
        assert_eq!(at, (1200 + 12 - 360 / 2, 22 + 24));
    }

    #[test]
    fn never_opens_left_of_the_monitor_for_an_icon_near_the_left_edge() {
        let at = anchor_to_icon(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            PhysicalPosition::new(0, 1050),
            PhysicalSize::new(24, 24),
            WINDOW,
            MARGIN,
        );
        assert_eq!(at.0, 0);
    }

    #[test]
    fn honors_a_tray_icon_on_a_display_at_negative_coordinates() {
        let at = anchor_to_icon(
            PhysicalPosition::new(-1920, 0),
            PhysicalSize::new(1920, 1080),
            PhysicalPosition::new(-100, 1050),
            PhysicalSize::new(24, 24),
            WINDOW,
            MARGIN,
        );
        // Centered on the icon (-88 - 180 = -268), then pulled back to the
        // monitor's own right edge (-1920 + 1920 - 360) since it would
        // otherwise overhang past this display.
        assert_eq!(at, (-360, 1050 - 440 - 24));
    }
}
