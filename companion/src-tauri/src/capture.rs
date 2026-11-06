//! Windows screen capture for the scan: while detection is on and Star Citizen is the foreground window,
//! one frame per second of its client area (BGRA, converted only if it is read), sent to the OCR worker
//! (`ocrwatch`), which gates and reads it; while detection is on it also tells whether the game runs at all
//! (`game-seen`, for the state row). The capture itself is sc-ohseearr's (`sc_ohseearr_capture_win`): DXGI
//! Desktop Duplication, the image of the game's monitor cut to the window (no capture border, unlike
//! Windows.Graphics.Capture on Windows 10), the cursor in it, the cursor's rest. This module is the loop on
//! top of it: the interval, the worker's pull, the events. Window and monitor coordinates are physical
//! pixels: Tauri makes the process per-monitor DPI aware.

use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sc_ohseearr_capture_win::{Captured, Found, Grab, Rest, Window, WindowCapture, PULL_POLL, REST};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{HWND, RECT};

use crate::ocrwatch::{CaptureInfo, Detect, FastCapture, Frame, GameFront, GameSeen, GAME_FRONT, GAME_SEEN, PULL_TIMEOUT_MS};

const GAME_EXE: &str = "StarCitizen.exe";
const INTERVAL: Duration = Duration::from_secs(1);

/// Starts the capture thread; it sends frames only while `detect` is on and the game is in front
/// (one per second, on the warehouse and the character inventory when the worker pulls, `FastCapture`),
/// and tells whether the game runs (`seen`, only while `detect` is on).
pub fn spawn(app: AppHandle, tx: Sender<Frame>, detect: Detect, seen: GameSeen, fast: FastCapture, front: GameFront) {
    std::thread::spawn(move || {
        // The game window last seen in front counts while the companion itself is in front (`Found::in_front`
        // false); the skipped grabs go into the next frame's info
        let mut cap = WindowCapture::new(GAME_EXE);
        let mut last_error = String::new();
        let mut rest = Rest::default();
        loop {
            // Pulled by the worker (warehouse, character inventory): as soon as it is ready and the cursor
            // rests (the game then shows the tooltip of the tile under it; `SETTLED_MS` in components.ts), at
            // the latest after an interval (the checks below run that often; no frame then)
            let pulled = fast.0.load(Ordering::Relaxed) > 0;
            let mut grab_now = !pulled;
            if pulled {
                let waiting = Instant::now();
                while waiting.elapsed() < INTERVAL {
                    std::thread::sleep(PULL_POLL);
                    rest.update();
                    let ready = now_ms() >= fast.0.load(Ordering::Relaxed);
                    if ready && rest.rested() >= REST {
                        grab_now = true;
                        break;
                    }
                }
            } else {
                std::thread::sleep(INTERVAL);
            }
            let on = detect.load(Ordering::Relaxed);
            let game = if on { cap.window() } else { None };
            let running = on && (game.is_some() || cap.is_running());
            if seen.0.swap(running, Ordering::Relaxed) != running {
                let _ = app.emit(GAME_SEEN, running);
            }
            let in_front = game.is_some_and(|f| f.in_front);
            if front.0.swap(in_front, Ordering::Relaxed) != in_front {
                let _ = app.emit(GAME_FRONT, in_front);
            }
            let Some(Found { window, in_front }) = game else {
                // No game window, or the scan off: the duplication is closed (`window()` does that itself)
                cap.reset();
                continue;
            };
            // The companion in front: no frames (the capture is of the monitor, the companion's own window
            // over the game was read as a warehouse grid and switched the mode while the user worked in it)
            if !in_front || !grab_now {
                continue;
            }
            match cap.grab_window(window) {
                Ok(Grab::Frame(Captured { pixels, cursor, info, .. })) => {
                    last_error.clear();
                    let rest_ms = if pulled { rest.rested().as_millis() as u32 } else { 0 };
                    let capture = CaptureInfo {
                        grab_ms: info.grab_ms,
                        skipped_timeout: info.skipped_timeout,
                        skipped_pointer: info.skipped_pointer,
                        skipped_outside: info.skipped_outside,
                        rest_ms,
                        ..CaptureInfo::default()
                    };
                    // The next pulled frame once the worker read this one (or after the timeout); left off
                    // when the worker switched it off meanwhile
                    let _ = fast.0.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| (v > 0).then(|| now_ms() + PULL_TIMEOUT_MS));
                    if tx.send(Frame { at_ms: now_ms(), pixels, live: true, cursor, capture }).is_err() {
                        return;
                    }
                }
                // Counted by the capture into the next frame's info
                Ok(Grab::Skipped(_)) => {}
                Err(e) => {
                    // Mode change, fullscreen switch, secure desktop (UAC): the capture opens it again next time
                    let e = e.to_string();
                    if e != last_error {
                        log::warn!("screen capture: {e}");
                        last_error = e;
                    }
                }
            }
        }
    });
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The foreground window if it is Star Citizen's and not minimized (the scan overlay follows it;
/// unlike the capture, the companion in front does not count).
pub fn foreground_game() -> Option<HWND> {
    WindowCapture::new(GAME_EXE).foreground_window().map(|w| HWND(w.raw() as *mut _))
}

/// The window's client area in screen coordinates (physical pixels).
pub fn client_rect(hwnd: HWND) -> Result<RECT, String> {
    let r = Window::from_raw(hwnd.0 as isize).client_rect().map_err(|e| e.to_string())?;
    Ok(RECT { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
}
