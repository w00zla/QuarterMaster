//! Linux screen capture for the scan, the counterpart of the Windows `capture.rs` (same frames, events and
//! flags): while detection is on, one frame per second of Star Citizen's window (two a second in the signature
//! scan), sent to the OCR worker (`ocrwatch`); while detection is on it also tells whether the game runs
//! (`game-seen`). The capture itself is sc-ohseearr's (`sc_ohseearr_capture_linux`): the ScreenCast portal, where
//! the user picks the window, and a PipeWire stream of the window's own content with the cursor's position in it.
//! This module is the loop on top of it: when the portal is asked, the interval, the worker's pull, the events.
//!
//! The portal is asked only after the user started the scan (never on its own after the dialog was cancelled: it
//! would come back every second). The restore token is kept for this run only: within it the window comes back
//! without the dialog (the scan started again, the game restarted), after the companion's restart the user picks
//! it once more. The stream is the window's content, not the monitor's: nothing lies over it, so the game counts
//! as in front while the stream runs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sc_ohseearr_capture::PULL_POLL;
use sc_ohseearr_capture_linux::{Captured, OpenError, WindowCapture};
use tauri::{AppHandle, Emitter};

use crate::ocrwatch::{CaptureInfo, Detect, FastCapture, Frame, GameFront, GameSeen, SignatureCapture, GAME_FRONT, GAME_SEEN, PULL_TIMEOUT_MS};

const GAME_EXE: &str = "StarCitizen.exe";
const INTERVAL: Duration = Duration::from_secs(1);
/// The signature scan's interval (as on Windows: the radar signature changes quickly)
const SIGNATURE_INTERVAL: Duration = Duration::from_millis(500);

/// Starts the capture thread; it sends frames only while `detect` is on and the stream runs (one per second,
/// two in the signature scan, on the warehouse and the character inventory when the worker pulls,
/// `FastCapture`), and tells whether the game runs (`seen`, only while `detect` is on).
#[allow(clippy::too_many_arguments)]
pub fn spawn(app: AppHandle, tx: Sender<Frame>, detect: Detect, seen: GameSeen, fast: FastCapture, front: GameFront, signature: SignatureCapture) {
    std::thread::spawn(move || {
        let mut cap = WindowCapture::new(GAME_EXE);
        // The portal's restore token for the next `open` (this run only)
        let mut token: Option<String> = None;
        // The user started the scan: the portal may be asked (cleared when its dialog was cancelled)
        let mut armed = false;
        let mut was_on = false;
        let mut last_grab = Instant::now();
        let mut last_error = String::new();
        loop {
            let on = detect.load(Ordering::Relaxed);
            if on && !was_on {
                armed = true;
            }
            was_on = on;
            if !on {
                // The scan off: the stream and the portal's session end (the desktop's sharing indicator goes)
                if cap.is_open() {
                    log::info!("screen capture closed (scan stopped)");
                }
                cap.close();
                set(&app, &seen.0, GAME_SEEN, false);
                set(&app, &front.0, GAME_FRONT, false);
                std::thread::sleep(INTERVAL);
                continue;
            }
            let open = cap.is_open();
            set(&app, &seen.0, GAME_SEEN, open || cap.is_running());
            if !open {
                set(&app, &front.0, GAME_FRONT, false);
                // A stream that ended (the window closed, the session revoked): its session goes too
                cap.close();
                if !armed || !cap.is_running() {
                    std::thread::sleep(INTERVAL);
                    continue;
                }
                // Blocks while the portal's dialog is open; without a token the user picks the window
                match cap.open(token.as_deref()) {
                    Ok(next) => {
                        log::info!("screen capture opened ({})", if token.is_some() { "restored" } else { "picked" });
                        token = next;
                        last_error.clear();
                    }
                    Err(OpenError::NotRunning) => continue,
                    Err(e) => {
                        // Cancelled, or the portal failed: no new try until the user starts the scan again
                        // (the dialog would come back every second); the token may be spent
                        log::warn!("screen capture: {e}");
                        token = None;
                        armed = false;
                        stop_scan(&app, &detect);
                        continue;
                    }
                }
                if !detect.load(Ordering::Relaxed) {
                    // Switched off while the dialog was open: closed in the next round
                    continue;
                }
                set(&app, &front.0, GAME_FRONT, true);
            }
            // Pulled by the worker (warehouse, character inventory): once it is ready (at the latest after an
            // interval, the checks above run that often; no frame then), the next image whose cursor rests
            let pulled = fast.0.load(Ordering::Relaxed) > 0;
            let grab = if pulled {
                let waiting = Instant::now();
                while now_ms() < fast.0.load(Ordering::Relaxed) && waiting.elapsed() < INTERVAL {
                    std::thread::sleep(PULL_POLL);
                }
                if now_ms() < fast.0.load(Ordering::Relaxed) {
                    continue;
                }
                cap.grab_rested(INTERVAL)
            } else {
                let interval = if signature.0.load(Ordering::Relaxed) { SIGNATURE_INTERVAL } else { INTERVAL };
                std::thread::sleep(interval.saturating_sub(last_grab.elapsed()));
                last_grab = Instant::now();
                cap.grab(INTERVAL)
            };
            match grab {
                Ok(Some(Captured { pixels, cursor, rested, info })) => {
                    last_error.clear();
                    let capture = CaptureInfo {
                        grab_ms: info.grab_ms,
                        skipped_timeout: info.skipped_timeout,
                        skipped_pointer: info.skipped_pointer,
                        rest_ms: if pulled { rested.as_millis() as u32 } else { 0 },
                        ..CaptureInfo::default()
                    };
                    // The next pulled frame once the worker read this one (or after the timeout); left off
                    // when the worker switched it off meanwhile
                    let _ = fast.0.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| (v > 0).then(|| now_ms() + PULL_TIMEOUT_MS));
                    if tx.send(Frame { at_ms: now_ms(), pixels, live: true, cursor, capture }).is_err() {
                        return;
                    }
                }
                // No image within the timeout: counted by the capture into the next frame's info
                Ok(None) => {}
                Err(e) => {
                    // The stream ended (the game closed, the session revoked): closed and, while the game runs,
                    // opened again with the token; without one the scan stops (the dialog must not come unasked)
                    let e = e.to_string();
                    if e != last_error {
                        log::warn!("screen capture: {e}");
                        last_error = e;
                    }
                    cap.close();
                    if token.is_none() {
                        armed = false;
                        stop_scan(&app, &detect);
                    }
                }
            }
        }
    });
}

/// Stores a flag and tells the frontend when it changed.
fn set(app: &AppHandle, flag: &AtomicBool, event: &str, value: bool) {
    if flag.swap(value, Ordering::Relaxed) != value {
        let _ = app.emit(event, value);
    }
}

/// Switches the scan off as `set_scan` does (every window hears about it).
fn stop_scan(app: &AppHandle, detect: &Detect) {
    if detect.swap(false, Ordering::Relaxed) {
        log::info!("scan off (screen capture)");
        let _ = app.emit(crate::SCAN_CHANGED, false);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}
