//! The scan overlay (Windows): a frameless, transparent, click-through window that never takes the
//! focus (`overlay.html`, it shows what the main window sends). While it is on, a thread puts it in
//! the configured place (a corner, or the middle of the top or bottom edge) of the game window's
//! client area, always on top, but only while Star Citizen
//! is the foreground window; otherwise it is hidden. It is excluded from screen captures
//! (`WDA_EXCLUDEFROMCAPTURE`): the desktop duplication would read it along with the game. Its two
//! hotkeys (on/off, mode) are watched system-wide; the main window acts on them (`overlay-hotkey`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, MapVirtualKeyW, MAPVK_VSC_TO_VK, VK_CONTROL, VK_MENU, VK_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowDisplayAffinity, SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
    WDA_EXCLUDEFROMCAPTURE,
};

use crate::capture;

/// The overlay window's label (capabilities/default.json lists it)
pub const LABEL: &str = "overlay";
// The tile's fixed size and its distance to the game window's edges (logical pixels): a 22 px location
// line and 8 rows of 20 px (OverlayApp.vue, overlayLayout.ts) with the border and padding, the
// ~28 px mode rail on the right; the display "thumbs" a little higher (a 60 px top row and 6 rows)
const WIDTH: f64 = 340.0;
const HEIGHT: f64 = 190.0;
const HEIGHT_THUMBS: f64 = 210.0;
const MARGIN: f64 = 24.0;

/// The tile's height in the configured display ("thumbs" or "compact").
fn height(display: &str) -> f64 {
    if display == "compact" {
        HEIGHT
    } else {
        HEIGHT_THUMBS
    }
}
// How often the place and the foreground window are checked
const TICK: Duration = Duration::from_millis(250);

/// Whether the overlay is on (the main window switches it; off at every start).
#[derive(Clone, Default)]
pub struct Overlay(pub Arc<AtomicBool>);

/// Opens the overlay window (hidden until the game is in front) or closes it; `display` gives its first
/// height (the placing thread follows a change).
pub fn set(app: &AppHandle, overlay: &Overlay, on: bool, display: &str) -> Result<(), String> {
    overlay.0.store(on, Ordering::Relaxed);
    let existing = app.get_webview_window(LABEL);
    if !on {
        if let Some(w) = existing {
            w.destroy().map_err(|e| e.to_string())?;
        }
        log::info!("overlay off");
        return Ok(());
    }
    if existing.is_some() {
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("overlay.html".into()))
        .title("Quartermaster Companion – Overlay")
        .inner_size(WIDTH, height(display))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .additional_browser_args(crate::BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    // Before the click-through: a layered window (WS_EX_LAYERED) refuses the exclusion (error 8),
    // one excluded before becoming layered stays excluded
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    if let Err(e) = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) } {
        // The capture would read the overlay along with the game
        log::warn!("overlay: not excluded from the screen capture: {e}");
    }
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    log::info!("overlay on");
    Ok(())
}

/// Starts the thread that places the overlay over the game window, or hides it while the game is
/// not in front. `config` gives the configured place and display (its height: a change applies with
/// the next tick).
pub fn spawn(app: AppHandle, overlay: Overlay, config: impl Fn() -> (String, String) + Send + 'static) {
    std::thread::spawn(move || {
        // The place last set, None while hidden
        let mut shown: Option<RECT> = None;
        loop {
            std::thread::sleep(TICK);
            if !overlay.0.load(Ordering::Relaxed) {
                shown = None;
                continue;
            }
            let Some(hwnd) = app.get_webview_window(LABEL).and_then(|w| w.hwnd().ok()) else { continue };
            let place = capture::foreground_game().and_then(|game| {
                let client = capture::client_rect(game).ok()?;
                let (position, display) = config();
                Some(place(client, scale(game), &position, height(&display)))
            });
            match place {
                // Every tick: the game may have pushed itself above the overlay
                Some(r) => unsafe {
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                    shown = Some(r);
                },
                None if shown.is_some() => unsafe {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                    shown = None;
                },
                None => {}
            }
        }
    });
}

/// The scale of the monitor showing the game window (its DPI / 96).
fn scale(game: HWND) -> f64 {
    unsafe {
        let monitor = MonitorFromWindow(game, MONITOR_DEFAULTTONEAREST);
        let (mut x, mut y) = (96, 96);
        match GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) {
            Ok(()) => x as f64 / 96.0,
            Err(_) => 1.0,
        }
    }
}

/// The overlay's place at `position` in the game's client area ("top-left", "top-center", …;
/// anything else is top left), `height` logical pixels high, screen pixels.
fn place(client: RECT, scale: f64, position: &str, height: f64) -> RECT {
    let (w, h, m) = ((WIDTH * scale).round() as i32, (height * scale).round() as i32, (MARGIN * scale).round() as i32);
    let x = if position.ends_with("-right") {
        client.right - m - w
    } else if position.ends_with("-center") {
        (client.left + client.right) / 2 - w / 2
    } else {
        client.left + m
    };
    let y = if position.starts_with("bottom-") { client.bottom - m - h } else { client.top + m };
    RECT { left: x, top: y, right: x + w, bottom: y + h }
}

// --- hotkeys -----------------------------------------------------------------------------------
// Polled, not registered: RegisterHotKey stays silent while Star Citizen is in front (its raw input
// keeps application hotkeys away), the key state is read either way. The keys reach the game too.

/// A hotkey: the modifiers held (exactly these) and the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hotkey {
    ctrl: bool,
    alt: bool,
    shift: bool,
    key: Key,
}

/// A virtual key, or a character key's scan code (its virtual key depends on the keyboard layout:
/// the settings record the physical key)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Vk(u16),
    Scan(u32),
}

/// The overlay's hotkeys: on/off, mode.
#[derive(Default)]
pub struct Hotkeys(pub Mutex<[Option<Hotkey>; 2]>);

const ACTIONS: [&str; 2] = ["toggle", "mode"];
// An overlay hotkey was pressed: "toggle" or "mode" (the main window acts on it)
const OVERLAY_HOTKEY: &str = "overlay-hotkey";
const HOTKEY_TICK: Duration = Duration::from_millis(30);

/// An accelerator as the settings record it ("Ctrl+Shift+KeyQ": the modifiers, then the physical
/// key's code as the browser names it); None for anything else.
fn parse_hotkey(text: &str) -> Option<Hotkey> {
    let mut parts: Vec<&str> = text.split('+').collect();
    let key = key_of(parts.pop()?)?;
    let (mut ctrl, mut alt, mut shift) = (false, false, false);
    for p in parts {
        match p {
            "Ctrl" => ctrl = true,
            "Alt" => alt = true,
            "Shift" => shift = true,
            _ => return None,
        }
    }
    Some(Hotkey { ctrl, alt, shift, key })
}

/// The key of a browser key code: character keys by their scan code (set 1), the others by their
/// virtual key.
fn key_of(code: &str) -> Option<Key> {
    let scan_in = |c: &str, rows: &[(&str, u32)]| {
        let mut chars = c.chars();
        let ch = chars.next().filter(|_| chars.next().is_none())?;
        rows.iter().find_map(|(row, first)| row.find(ch).map(|i| Key::Scan(first + i as u32)))
    };
    if let Some(letter) = code.strip_prefix("Key") {
        return scan_in(letter, &[("QWERTYUIOP", 0x10), ("ASDFGHJKL", 0x1E), ("ZXCVBNM", 0x2C)]);
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return scan_in(digit, &[("1234567890", 0x02)]);
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some(Key::Vk(0x70 + n - 1));
    }
    if let Some(n) = code.strip_prefix("Numpad").and_then(|n| n.parse::<u16>().ok()).filter(|n| *n <= 9) {
        return Some(Key::Vk(0x60 + n));
    }
    let vk = match code {
        "Space" => 0x20,
        "Tab" => 0x09,
        "Enter" => 0x0D,
        "Pause" => 0x13,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "End" => 0x23,
        "Home" => 0x24,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        "NumpadMultiply" => 0x6A,
        "NumpadAdd" => 0x6B,
        "NumpadSubtract" => 0x6D,
        "NumpadDecimal" => 0x6E,
        "NumpadDivide" => 0x6F,
        "ScrollLock" => 0x91,
        _ => 0,
    };
    if vk != 0 {
        return Some(Key::Vk(vk));
    }
    let scan = match code {
        "Minus" => 0x0C,
        "Equal" => 0x0D,
        "BracketLeft" => 0x1A,
        "BracketRight" => 0x1B,
        "Semicolon" => 0x27,
        "Quote" => 0x28,
        "Backquote" => 0x29,
        "Backslash" => 0x2B,
        "Comma" => 0x33,
        "Period" => 0x34,
        "Slash" => 0x35,
        "IntlBackslash" => 0x56,
        _ => return None,
    };
    Some(Key::Scan(scan))
}

/// Takes the hotkeys (accelerators, empty = none) in place of the ones before. Refused, nothing
/// changed: "hotkeyInvalid" (no key combination this reads), "hotkeySame" (both the same).
pub fn set_hotkeys(app: &AppHandle, toggle: &str, mode: &str) -> Result<(), String> {
    let parse = |text: &str| if text.is_empty() { Ok(None) } else { parse_hotkey(text).map(Some).ok_or("hotkeyInvalid".to_string()) };
    let keys = [parse(toggle)?, parse(mode)?];
    if keys[0].is_some() && keys[0] == keys[1] {
        return Err("hotkeySame".into());
    }
    *app.state::<Hotkeys>().0.lock().unwrap() = keys;
    Ok(())
}

/// Starts the thread that watches the hotkeys: a press (the combination going down) goes to the
/// main window as `overlay-hotkey`.
pub fn spawn_hotkeys(app: AppHandle) {
    std::thread::spawn(move || {
        let mut held = [false; 2];
        loop {
            std::thread::sleep(HOTKEY_TICK);
            let keys = *app.state::<Hotkeys>().0.lock().unwrap();
            for (i, key) in keys.iter().enumerate() {
                let down = key.is_some_and(|k| pressed(&k));
                if down && !held[i] {
                    let _ = app.emit(OVERLAY_HOTKEY, ACTIONS[i]);
                }
                held[i] = down;
            }
        }
    });
}

fn pressed(k: &Hotkey) -> bool {
    let down = |vk: u16| unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 };
    let vk = match k.key {
        Key::Vk(vk) => vk,
        // The current keyboard layout's key at that place
        Key::Scan(scan) => unsafe { MapVirtualKeyW(scan, MAPVK_VSC_TO_VK) as u16 },
    };
    vk != 0 && down(vk) && down(VK_CONTROL.0) == k.ctrl && down(VK_MENU.0) == k.alt && down(VK_SHIFT.0) == k.shift
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT { left, top, right, bottom }
    }

    #[test]
    fn placed_in_a_corner_or_centred() {
        let game = rect(1000, 0, 4840, 1600);
        assert_eq!(place(game, 1.0, "top-left", HEIGHT), rect(1024, 24, 1364, 214));
        assert_eq!(place(game, 1.0, "top-right", HEIGHT), rect(4476, 24, 4816, 214));
        assert_eq!(place(game, 1.0, "bottom-left", HEIGHT), rect(1024, 1386, 1364, 1576));
        assert_eq!(place(game, 1.0, "bottom-right", HEIGHT), rect(4476, 1386, 4816, 1576));
        assert_eq!(place(game, 1.0, "top-center", HEIGHT), rect(2750, 24, 3090, 214));
        assert_eq!(place(game, 1.0, "bottom-center", HEIGHT), rect(2750, 1386, 3090, 1576));
        // Unknown: top left; scaled with the monitor
        assert_eq!(place(game, 1.5, "?", HEIGHT), rect(1036, 36, 1546, 321));
        // The display "thumbs" is higher; at the bottom it grows upwards
        assert_eq!(place(game, 1.0, "top-left", height("thumbs")), rect(1024, 24, 1364, 234));
        assert_eq!(place(game, 1.0, "bottom-left", height("thumbs")), rect(1024, 1366, 1364, 1576));
        assert_eq!(height("compact"), HEIGHT);
    }

    #[test]
    fn hotkeys_as_recorded() {
        let q = parse_hotkey("Ctrl+Shift+KeyQ").unwrap();
        assert_eq!(q, Hotkey { ctrl: true, alt: false, shift: true, key: Key::Scan(0x10) });
        assert_eq!(parse_hotkey("Alt+KeyM").unwrap().key, Key::Scan(0x32));
        assert_eq!(parse_hotkey("Ctrl+Digit0").unwrap().key, Key::Scan(0x0B));
        assert_eq!(parse_hotkey("F9").unwrap(), Hotkey { ctrl: false, alt: false, shift: false, key: Key::Vk(0x78) });
        assert_eq!(parse_hotkey("Ctrl+Numpad5").unwrap().key, Key::Vk(0x65));
        assert_eq!(parse_hotkey("Ctrl+Backquote").unwrap().key, Key::Scan(0x29));
        for bad in ["", "Ctrl+", "Ctrl+KeyQQ", "Win+KeyQ", "Ctrl+Key1", "Ctrl+F25", "Ctrl+Fn"] {
            assert_eq!(parse_hotkey(bad), None, "{bad}");
        }
    }
}
