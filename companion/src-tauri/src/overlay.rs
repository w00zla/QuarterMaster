//! The scan overlay (Windows): a frameless, transparent, click-through window that never takes the
//! focus (`overlay.html`, it shows what the main window sends). While it is on, a thread puts it in
//! the configured place (a corner, or the middle of the top or bottom edge) of the game window's
//! client area, always on top, but only while Star Citizen
//! is the foreground window; otherwise it is hidden. It is excluded from screen captures
//! (`WDA_EXCLUDEFROMCAPTURE`): the desktop duplication would read it along with the game. Its three
//! hotkeys (on/off, mode, scan mode) are watched system-wide; the main window acts on them (`overlay-hotkey`).
//!
//! With it comes the signature overlay (`signature.html`, the same kind of window): while the signature scan
//! sees a radar signature it sits next to the number (below, above, left or right of it, the settings say),
//! with the resources the main window evaluated from it; it hides once the last signature seen is older than
//! `SIGNATURE_STALE`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::ocrwatch::{SignatureSeen, SignatureSpot};

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
/// The signature overlay's window
pub const LABEL_SIGNATURE: &str = "signature";
// The tile's fixed size and its distance to the game window's edges (logical pixels): a 22 px location
// line and 6 rows of 20 px (OverlayApp.vue, overlayLayout.ts) with the border and padding, the
// ~28 px mode rail on the right (five modes); the display "thumbs" higher (a 60 px top row and 6 rows)
// and wider by the rows' small thumbnails
const WIDTH: f64 = 300.0;
const HEIGHT: f64 = 150.0;
const WIDTH_THUMBS: f64 = 340.0;
const HEIGHT_THUMBS: f64 = 210.0;
const MARGIN: f64 = 24.0;
// The signature overlay's window (logical pixels): room for a few resources; its tile sits at the side
// facing the number (SignatureApp.vue), the rest stays transparent
const SIGNATURE_WIDTH: f64 = 220.0;
const SIGNATURE_HEIGHT: f64 = 120.0;
// Between the number and the window
const SIGNATURE_GAP: f64 = 8.0;
/// The signature overlay hides once the last signature seen is this old (the scan reads twice a second;
/// a few frames without a readable plate keep it)
pub const SIGNATURE_STALE: Duration = Duration::from_millis(1500);

/// The tile's size (width, height) in the configured display ("thumbs" or "compact").
fn size(display: &str) -> (f64, f64) {
    if display == "compact" {
        (WIDTH, HEIGHT)
    } else {
        (WIDTH_THUMBS, HEIGHT_THUMBS)
    }
}
// How often the scan overlay's place and the foreground window are checked
const TICK: Duration = Duration::from_millis(250);
// The signature overlay follows a new signature this soon (the scan reads two a second)
const SIGNATURE_TICK: Duration = Duration::from_millis(50);
const TICKS_PER_PLACE: u32 = (TICK.as_millis() / SIGNATURE_TICK.as_millis()) as u32;

/// Whether the overlay is on (the main window switches it; off at every start).
#[derive(Clone, Default)]
pub struct Overlay(pub Arc<AtomicBool>);

/// Opens the overlay windows (hidden until the game is in front, the signature overlay until a signature is
/// seen) or closes them; `display` gives the scan overlay's first size (the placing thread follows a change).
pub fn set(app: &AppHandle, overlay: &Overlay, on: bool, display: &str) -> Result<(), String> {
    overlay.0.store(on, Ordering::Relaxed);
    if !on {
        for label in [LABEL, LABEL_SIGNATURE] {
            if let Some(w) = app.get_webview_window(label) {
                w.destroy().map_err(|e| e.to_string())?;
            }
        }
        log::info!("overlay off");
        return Ok(());
    }
    if app.get_webview_window(LABEL).is_none() {
        open(app, LABEL, "overlay.html", "Overlay", size(display))?;
    }
    if app.get_webview_window(LABEL_SIGNATURE).is_none() {
        open(app, LABEL_SIGNATURE, "signature.html", "Signature", (SIGNATURE_WIDTH, SIGNATURE_HEIGHT))?;
    }
    log::info!("overlay on");
    Ok(())
}

/// Builds one of the overlay windows: frameless, transparent, click-through, never focused, hidden, excluded
/// from the screen capture.
fn open(app: &AppHandle, label: &str, page: &str, name: &str, (width, height): (f64, f64)) -> Result<(), String> {
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(page.into()))
        .title(format!("Quartermaster Companion – {name}"))
        .inner_size(width, height)
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
        log::warn!("{label}: not excluded from the screen capture: {e}");
    }
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    Ok(())
}

/// What the placing thread needs of the config: the scan overlay's place and display, whether it hides (the
/// signature scan runs and the settings show the signature overlay alone), the signature overlay's side.
pub struct Placing {
    pub position: String,
    pub display: String,
    pub hide_scan_overlay: bool,
    pub signature_position: String,
}

/// Starts the thread that places the overlays over the game window, or hides them while the game is not in
/// front (the signature overlay also while no recent signature is seen). `config` gives the configured places
/// and display (the scan overlay's height: a change applies with the next tick).
pub fn spawn(app: AppHandle, overlay: Overlay, seen: SignatureSeen, config: impl Fn() -> Placing + Send + 'static) {
    std::thread::spawn(move || {
        // The places last set, None while hidden
        let mut shown: Option<RECT> = None;
        let mut shown_signature: Option<RECT> = None;
        let mut ticks: u32 = 0;
        loop {
            std::thread::sleep(SIGNATURE_TICK);
            if !overlay.0.load(Ordering::Relaxed) {
                shown = None;
                shown_signature = None;
                continue;
            }
            let game = capture::foreground_game().and_then(|game| Some((game, capture::client_rect(game).ok()?)));
            let c = config();
            // The scan overlay only every TICK: it stays where it is
            ticks = ticks.wrapping_add(1);
            if ticks.is_multiple_of(TICKS_PER_PLACE) || game.is_none() || c.hide_scan_overlay {
                let tile = game.filter(|_| !c.hide_scan_overlay).map(|(g, client)| place(client, scale(g), &c.position, size(&c.display)));
                show_at(&app, LABEL, tile, &mut shown);
            }
            let spot = *seen.0.lock().unwrap();
            let signature = game.zip(spot.filter(|s| s.at.elapsed() < SIGNATURE_STALE)).map(|((g, client), spot)| {
                place_signature(client, scale(g), &spot, &c.signature_position, (SIGNATURE_WIDTH, SIGNATURE_HEIGHT))
            });
            // Moved at once; where it stays, put on top again only every TICK
            if signature != shown_signature || ticks.is_multiple_of(TICKS_PER_PLACE) {
                show_at(&app, LABEL_SIGNATURE, signature, &mut shown_signature);
            }
        }
    });
}

/// Puts a window at `place` (on top) or hides it (None).
fn show_at(app: &AppHandle, label: &str, place: Option<RECT>, shown: &mut Option<RECT>) {
    let Some(hwnd) = app.get_webview_window(label).and_then(|w| w.hwnd().ok()) else { return };
    match place {
        // Every tick: the game may have pushed itself above the overlay
        Some(r) => unsafe {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            *shown = Some(r);
        },
        None if shown.is_some() => unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
            *shown = None;
        },
        None => {}
    }
}

/// The signature overlay's place next to the number (`spot`, frame pixels: the frame is the game's client
/// area) on the `position` side ("below", "above", "left", "right"; anything else is below), `size` (width,
/// height) in logical pixels, screen pixels: centred on the number along that side, `SIGNATURE_GAP` away.
fn place_signature(client: RECT, scale: f64, spot: &SignatureSpot, position: &str, (width, height): (f64, f64)) -> RECT {
    // Frame pixels to screen pixels (a capture smaller than the client area, should one come, scales)
    let sx = (client.right - client.left) as f64 / spot.width.max(1) as f64;
    let sy = (client.bottom - client.top) as f64 / spot.height.max(1) as f64;
    let (x0, y0) = (client.left as f64 + spot.rect.x0 as f64 * sx, client.top as f64 + spot.rect.y0 as f64 * sy);
    let (x1, y1) = (client.left as f64 + spot.rect.x1 as f64 * sx, client.top as f64 + spot.rect.y1 as f64 * sy);
    let (w, h, gap) = (width * scale, height * scale, SIGNATURE_GAP * scale);
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    let (left, top) = match position {
        "above" => (cx - w / 2.0, y0 - gap - h),
        "left" => (x0 - gap - w, cy - h / 2.0),
        "right" => (x1 + gap, cy - h / 2.0),
        _ => (cx - w / 2.0, y1 + gap),
    };
    let (left, top) = (left.round() as i32, top.round() as i32);
    RECT { left, top, right: left + w.round() as i32, bottom: top + h.round() as i32 }
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
/// anything else is top left), `size` (width, height) in logical pixels, screen pixels.
fn place(client: RECT, scale: f64, position: &str, (width, height): (f64, f64)) -> RECT {
    let (w, h, m) = ((width * scale).round() as i32, (height * scale).round() as i32, (MARGIN * scale).round() as i32);
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

/// The overlay's hotkeys: on/off, mode, scan mode.
#[derive(Default)]
pub struct Hotkeys(pub Mutex<[Option<Hotkey>; 3]>);

const ACTIONS: [&str; 3] = ["toggle", "mode", "scanMode"];
// An overlay hotkey was pressed: "toggle", "mode" or "scanMode" (the main window acts on it)
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
/// changed: "hotkeyInvalid" (no key combination this reads), "hotkeySame" (two the same).
pub fn set_hotkeys(app: &AppHandle, toggle: &str, mode: &str, scan_mode: &str) -> Result<(), String> {
    *app.state::<Hotkeys>().0.lock().unwrap() = hotkeys(toggle, mode, scan_mode)?;
    Ok(())
}

fn hotkeys(toggle: &str, mode: &str, scan_mode: &str) -> Result<[Option<Hotkey>; 3], String> {
    let parse = |text: &str| if text.is_empty() { Ok(None) } else { parse_hotkey(text).map(Some).ok_or("hotkeyInvalid".to_string()) };
    let keys = [parse(toggle)?, parse(mode)?, parse(scan_mode)?];
    for (i, a) in keys.iter().enumerate() {
        if a.is_some() && keys[i + 1..].contains(a) {
            return Err("hotkeySame".into());
        }
    }
    Ok(keys)
}

/// Starts the thread that watches the hotkeys: a press (the combination going down) goes to the
/// main window as `overlay-hotkey`.
pub fn spawn_hotkeys(app: AppHandle) {
    std::thread::spawn(move || {
        let mut held = [false; 3];
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
        assert_eq!(place(game, 1.0, "top-left", (WIDTH, HEIGHT)), rect(1024, 24, 1324, 174));
        assert_eq!(place(game, 1.0, "top-right", (WIDTH, HEIGHT)), rect(4516, 24, 4816, 174));
        assert_eq!(place(game, 1.0, "bottom-left", (WIDTH, HEIGHT)), rect(1024, 1426, 1324, 1576));
        assert_eq!(place(game, 1.0, "bottom-right", (WIDTH, HEIGHT)), rect(4516, 1426, 4816, 1576));
        assert_eq!(place(game, 1.0, "top-center", (WIDTH, HEIGHT)), rect(2770, 24, 3070, 174));
        assert_eq!(place(game, 1.0, "bottom-center", (WIDTH, HEIGHT)), rect(2770, 1426, 3070, 1576));
        // Unknown: top left; scaled with the monitor
        assert_eq!(place(game, 1.5, "?", (WIDTH, HEIGHT)), rect(1036, 36, 1486, 261));
        // The display "thumbs" is higher and wider; at the bottom it grows upwards, at the right to the left
        assert_eq!(place(game, 1.0, "top-left", size("thumbs")), rect(1024, 24, 1364, 234));
        assert_eq!(place(game, 1.0, "bottom-left", size("thumbs")), rect(1024, 1366, 1364, 1576));
        assert_eq!(place(game, 1.0, "top-right", size("thumbs")), rect(4476, 24, 4816, 234));
        assert_eq!(size("compact"), (WIDTH, HEIGHT));
    }

    #[test]
    fn the_signature_overlay_sits_next_to_the_number() {
        // The game's client area at (1000, 0), the frame as large: frame pixels are the client's
        let game = rect(1000, 0, 4840, 1600);
        let spot = SignatureSpot {
            at: std::time::Instant::now(),
            rect: crate::ocr::Rect { x0: 1910.0, y0: 500.0, x1: 1970.0, y1: 525.0 },
            width: 3840,
            height: 1600,
        };
        let size = (SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
        // Centred under the number (its centre at x 2940 on the screen), 8 px below it
        assert_eq!(place_signature(game, 1.0, &spot, "below", size), rect(2830, 533, 3050, 653));
        assert_eq!(place_signature(game, 1.0, &spot, "above", size), rect(2830, 372, 3050, 492));
        assert_eq!(place_signature(game, 1.0, &spot, "left", size), rect(2682, 453, 2902, 573));
        assert_eq!(place_signature(game, 1.0, &spot, "right", size), rect(2978, 453, 3198, 573));
        // Unknown: below; scaled with the monitor
        assert_eq!(place_signature(game, 1.5, &spot, "?", size), rect(2775, 537, 3105, 717));
        // A 1080p frame in a 1080p client area at the screen's origin
        let small = SignatureSpot { rect: crate::ocr::Rect { x0: 896.0, y0: 337.0, x1: 937.0, y1: 354.0 }, width: 1920, height: 1080, ..spot };
        assert_eq!(place_signature(rect(0, 0, 1920, 1080), 1.0, &small, "below", size), rect(807, 362, 1027, 482));
    }

    #[test]
    fn hotkeys_differ() {
        assert!(hotkeys("Alt+Shift+KeyQ", "", "").is_ok());
        assert!(hotkeys("Alt+Shift+KeyQ", "F9", "F10").is_ok());
        assert_eq!(hotkeys("F9", "", "F9").unwrap_err(), "hotkeySame");
        assert_eq!(hotkeys("", "F9", "F9").unwrap_err(), "hotkeySame");
        assert_eq!(hotkeys("", "", "Win+KeyQ").unwrap_err(), "hotkeyInvalid");
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
