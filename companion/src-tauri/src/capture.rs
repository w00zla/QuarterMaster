//! Windows screen capture for the refinery OCR: while detection is on and Star Citizen is the
//! foreground window, one frame per second of its client area (BGRA, converted only if it is read),
//! sent to the OCR worker (`ocrwatch`), which gates and reads it; while detection is on it also tells whether the game runs at all
//! (`game-seen`, for the state row). DXGI Desktop Duplication: the image of the game's monitor, cut to the
//! window (no capture border, unlike Windows.Graphics.Capture on Windows 10). Window and monitor
//! coordinates are physical pixels: Tauri makes the process per-monitor DPI aware.

use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};
use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HMODULE, HWND, POINT, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BOX, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_FLAG, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_WAIT_TIMEOUT,
    DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Gdi::{ClientToScreen, MonitorFromWindow, HMONITOR, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindow};

use crate::ocrwatch::{CaptureInfo, Detect, FastCapture, Frame, GameFront, GameSeen, Pixels, GAME_FRONT, GAME_SEEN, PULL_TIMEOUT_MS};

const GAME_EXE: &str = "StarCitizen.exe";
const INTERVAL: Duration = Duration::from_secs(1);
// Waiting for a desktop frame: the game presents continuously, a timeout means nothing changed
const ACQUIRE_TIMEOUT_MS: u32 = 200;
// A grab slower than this is logged (debug)
const SLOW_GRAB: Duration = Duration::from_millis(150);
// While the worker pulls: how often the cursor is looked at, how far it may move and still rest
// (physical pixels), and how long it must rest before a grab (the game then shows the tooltip of the
// tile under it; `SETTLED_MS` in components.ts)
const PULL_POLL: Duration = Duration::from_millis(15);
const REST_PX: i32 = 3;
const REST: Duration = Duration::from_millis(200);

/// Since when the mouse cursor stays where it is.
struct Rest {
    at: POINT,
    since: Instant,
}

impl Default for Rest {
    fn default() -> Self {
        Self { at: POINT::default(), since: Instant::now() }
    }
}

impl Rest {
    fn update(&mut self) {
        let mut p = POINT::default();
        if unsafe { GetCursorPos(&mut p) }.is_err() {
            return;
        }
        if (p.x - self.at.x).abs() > REST_PX || (p.y - self.at.y).abs() > REST_PX {
            *self = Self { at: p, since: Instant::now() };
        }
    }

    fn rested(&self) -> Duration {
        self.since.elapsed()
    }
}

/// Starts the capture thread; it sends frames only while `detect` is on and the game is in front
/// (one per second, on the warehouse and the character inventory when the worker pulls, `FastCapture`),
/// and tells whether the game runs (`seen`, only while `detect` is on).
pub fn spawn(app: AppHandle, tx: Sender<Frame>, detect: Detect, seen: GameSeen, fast: FastCapture, front: GameFront) {
    std::thread::spawn(move || {
        let mut dup: Option<Duplication> = None;
        let mut last_error = String::new();
        // The game window last seen in front: it still counts while the companion itself is in front
        let mut last_game: Option<HWND> = None;
        // What went into the next frame's way (sent with it: debug view, recordings)
        let mut skipped = CaptureInfo::default();
        let mut rest = Rest::default();
        loop {
            // Pulled by the worker (warehouse, character inventory): as soon as it is ready and the cursor
            // rests, at the latest after an interval (the checks below run that often; no frame then)
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
            let game = if on { game_window(&mut last_game) } else { None };
            let running = on && (game.is_some() || game_running());
            if seen.0.swap(running, Ordering::Relaxed) != running {
                let _ = app.emit(GAME_SEEN, running);
            }
            let in_front = game.is_some_and(|(_, f)| f);
            if front.0.swap(in_front, Ordering::Relaxed) != in_front {
                let _ = app.emit(GAME_FRONT, in_front);
            }
            let Some((hwnd, in_front)) = game else {
                dup = None;
                continue;
            };
            // The companion in front: no frames (the capture is of the monitor, the companion's own window
            // over the game was read as a warehouse grid and switched the mode while the user worked in it)
            if !in_front || !grab_now {
                continue;
            }
            let started = Instant::now();
            match grab(&mut dup, hwnd) {
                Ok(Ok((pixels, cursor))) => {
                    last_error.clear();
                    // A slow copy to the CPU (the GPU busy with the game) delays every frame
                    if started.elapsed() > SLOW_GRAB {
                        log::debug!("screen capture: grab took {:?}", started.elapsed());
                    }
                    let rest_ms = if pulled { rest.rested().as_millis() as u32 } else { 0 };
                    let capture = CaptureInfo { grab_ms: started.elapsed().as_millis() as u32, rest_ms, ..std::mem::take(&mut skipped) };
                    // The next pulled frame once the worker read this one (or after the timeout); left off
                    // when the worker switched it off meanwhile
                    let _ = fast.0.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| (v > 0).then(|| now_ms() + PULL_TIMEOUT_MS));
                    if tx.send(Frame { at_ms: now_ms(), pixels, live: true, cursor, capture }).is_err() {
                        return;
                    }
                }
                Ok(Err(skip)) => match skip {
                    Skip::Timeout => skipped.skipped_timeout += 1,
                    Skip::Pointer => skipped.skipped_pointer += 1,
                    Skip::Outside => skipped.skipped_outside += 1,
                },
                Err(e) => {
                    // Mode change, fullscreen switch, secure desktop (UAC): open it again next time
                    dup = None;
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

trait Context<T> {
    fn ctx(self, what: &str) -> Result<T, String>;
}

impl<T> Context<T> for windows::core::Result<T> {
    fn ctx(self, what: &str) -> Result<T, String> {
        self.map_err(|e| format!("{what}: {e}"))
    }
}

/// The game's window and whether it is in front: the foreground window if it belongs to Star Citizen
/// and is not minimized (remembered in `last`; in front), or, while the companion itself is in front
/// (the user registers what was scanned), the game window seen before as long as it is up and not
/// minimized (not in front: the game still counts as seen, no frames are read). Any other window in
/// front ends the capture.
fn game_window(last: &mut Option<HWND>) -> Option<(HWND, bool)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() || IsIconic(hwnd).as_bool() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == GetCurrentProcessId() {
            return last.filter(|&h| IsWindow(Some(h)).as_bool() && !IsIconic(h).as_bool()).map(|h| (h, false));
        }
        let game = is_game_process(pid).then_some(hwnd);
        if game.is_some() {
            *last = game;
        }
        game.map(|h| (h, true))
    }
}

/// The foreground window if it is Star Citizen's and not minimized (the scan overlay follows it;
/// unlike the capture, the companion in front does not count).
pub fn foreground_game() -> Option<HWND> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() || IsIconic(hwnd).as_bool() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        is_game_process(pid).then_some(hwnd)
    }
}

/// Whether the process runs Star Citizen's executable.
fn is_game_process(pid: u32) -> bool {
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let named = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(process);
        named.is_ok() && is_game(&String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// Whether a Star Citizen process runs (in the background too).
fn game_running() -> bool {
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return false };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more && !found {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            found = is_game(&String::from_utf16_lossy(&entry.szExeFile[..len]));
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

fn is_game(exe_path: &str) -> bool {
    exe_path.rsplit(['\\', '/']).next().is_some_and(|name| name.eq_ignore_ascii_case(GAME_EXE))
}

/// The duplication of one monitor, kept while the game stays on it.
struct Duplication {
    monitor: HMONITOR,
    /// The monitor's place on the virtual desktop
    desktop: RECT,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    dup: IDXGIOutputDuplication,
    /// The CPU-readable copy target, kept while the crop's size stays
    staging: Option<(ID3D11Texture2D, u32, u32)>,
}

/// A part of the monitor's image, in its pixels.
#[derive(Debug, PartialEq)]
struct Crop {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

/// The window's client area (screen coordinates) within the monitor (`desktop`); None when outside.
fn crop(client: RECT, desktop: RECT) -> Option<Crop> {
    let left = client.left.max(desktop.left);
    let top = client.top.max(desktop.top);
    let right = client.right.min(desktop.right);
    let bottom = client.bottom.min(desktop.bottom);
    (right > left && bottom > top).then(|| Crop {
        x: (left - desktop.left) as u32,
        y: (top - desktop.top) as u32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

/// Why a grab brought no new frame.
enum Skip {
    /// No new image within ACQUIRE_TIMEOUT_MS
    Timeout,
    /// Only the mouse pointer moved (or the black first frame)
    Pointer,
    /// The game window is not on the duplicated monitor
    Outside,
}

/// One frame of the game window's client area with the mouse cursor's position in it (None when
/// outside: the duplicated image has no pointer, the inventory read needs it for the hovered tile);
/// a `Skip` when there is no new image.
fn grab(slot: &mut Option<Duplication>, hwnd: HWND) -> Result<Result<(Pixels, Option<(f32, f32)>), Skip>, String> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if slot.as_ref().is_none_or(|d| d.monitor != monitor) {
        *slot = None;
        let d = open(monitor)?;
        let r = d.desktop;
        log::debug!("screen capture on the monitor at ({}, {}), {}×{}", r.left, r.top, r.right - r.left, r.bottom - r.top);
        *slot = Some(d);
    }
    let d = slot.as_mut().expect("opened above");
    let Some(crop) = crop(client_rect(hwnd)?, d.desktop) else {
        log::debug!("screen capture: frame skipped (window outside the monitor)");
        return Ok(Err(Skip::Outside));
    };
    let pixels = match d.frame(&crop)? {
        Ok(p) => p,
        Err(skip) => return Ok(Err(skip)),
    };
    // The cursor relative to the frame's top left (screen position of the crop)
    let cursor = unsafe {
        let mut p = POINT::default();
        GetCursorPos(&mut p).ok().and_then(|_| {
            let (x, y) = (p.x - d.desktop.left - crop.x as i32, p.y - d.desktop.top - crop.y as i32);
            (x >= 0 && y >= 0 && (x as u32) < crop.width && (y as u32) < crop.height).then_some((x as f32, y as f32))
        })
    };
    Ok(Ok((pixels, cursor)))
}

/// The window's client area in screen coordinates (physical pixels).
pub fn client_rect(hwnd: HWND) -> Result<RECT, String> {
    unsafe {
        let mut r = RECT::default();
        GetClientRect(hwnd, &mut r).ctx("GetClientRect")?;
        let mut origin = POINT::default();
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return Err("ClientToScreen failed".into());
        }
        Ok(RECT { left: origin.x, top: origin.y, right: origin.x + r.right, bottom: origin.y + r.bottom })
    }
}

/// Duplicates the DXGI output showing `monitor`, on a device of the adapter driving it.
fn open(monitor: HMONITOR) -> Result<Duplication, String> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ctx("CreateDXGIFactory1")?;
        let mut a = 0;
        while let Ok(adapter) = factory.EnumAdapters1(a) {
            a += 1;
            let mut o = 0;
            while let Ok(output) = adapter.EnumOutputs(o) {
                o += 1;
                let desc = output.GetDesc().ctx("GetDesc")?;
                if desc.Monitor != monitor {
                    continue;
                }
                let (mut device, mut context) = (None, None);
                D3D11CreateDevice(
                    &adapter,
                    D3D_DRIVER_TYPE_UNKNOWN,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_FLAG(0),
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
                .ctx("D3D11CreateDevice")?;
                let device = device.ok_or("no D3D11 device")?;
                let context = context.ok_or("no D3D11 context")?;
                let dup = output.cast::<IDXGIOutput1>().ctx("IDXGIOutput1")?.DuplicateOutput(&device).ctx("DuplicateOutput")?;
                return Ok(Duplication { monitor, desktop: desc.DesktopCoordinates, device, context, dup, staging: None });
            }
        }
        Err("no DXGI output shows the game's monitor".into())
    }
}

impl Duplication {
    fn frame(&mut self, crop: &Crop) -> Result<Result<Pixels, Skip>, String> {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;
            match self.dup.AcquireNextFrame(ACQUIRE_TIMEOUT_MS, &mut info, &mut resource) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    log::debug!("screen capture: frame skipped (no new image within {ACQUIRE_TIMEOUT_MS} ms)");
                    return Ok(Err(Skip::Timeout));
                }
                Err(e) => return Err(format!("AcquireNextFrame: {e}")),
            }
            // No new desktop image (only the mouse pointer moved, or the black first frame)
            if info.LastPresentTime == 0 {
                let _ = self.dup.ReleaseFrame();
                log::debug!("screen capture: frame skipped (pointer only)");
                return Ok(Err(Skip::Pointer));
            }
            let copied = self.copy(resource, crop);
            let _ = self.dup.ReleaseFrame();
            copied.map(Ok)
        }
    }

    /// Copies the cropped part of the desktop image to the CPU (BGRA rows without padding).
    unsafe fn copy(&mut self, resource: Option<IDXGIResource>, c: &Crop) -> Result<Pixels, String> {
        let texture: ID3D11Texture2D = resource.ok_or("no desktop image")?.cast().ctx("ID3D11Texture2D")?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
            return Err(format!("desktop format {:?} not supported (HDR?)", desc.Format));
        }
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: c.width,
            Height: c.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: desc.Format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        if self.staging.as_ref().is_none_or(|(_, w, h)| (*w, *h) != (c.width, c.height)) {
            let mut staging = None;
            self.device.CreateTexture2D(&staging_desc, None, Some(&mut staging)).ctx("CreateTexture2D")?;
            self.staging = Some((staging.ok_or("no staging texture")?, c.width, c.height));
        }
        let staging = self.staging.as_ref().expect("created above").0.clone();
        let source = D3D11_BOX { left: c.x, top: c.y, front: 0, right: c.x + c.width, bottom: c.y + c.height, back: 1 };
        self.context.CopySubresourceRegion(&staging, 0, 0, 0, 0, &texture, 0, Some(&source));
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        self.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).ctx("Map")?;
        let pitch = mapped.RowPitch as usize;
        let data = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * c.height as usize);
        let pixels = Pixels::Bgra { data: unpad(data, pitch, c.width, c.height), width: c.width, height: c.height };
        self.context.Unmap(&staging, 0);
        Ok(pixels)
    }
}

/// BGRA rows of `pitch` bytes (padded) packed tightly.
fn unpad(data: &[u8], pitch: usize, width: u32, height: u32) -> Vec<u8> {
    let row = width as usize * 4;
    let mut out = Vec::with_capacity(row * height as usize);
    for line in data.chunks(pitch).take(height as usize) {
        out.extend_from_slice(&line[..row]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT { left, top, right, bottom }
    }

    #[test]
    fn game_exe_by_file_name() {
        assert!(is_game(r"C:\Games\StarCitizen\LIVE\Bin64\StarCitizen.exe"));
        assert!(is_game(r"D:\SC\LIVE\Bin64\starcitizen.EXE"));
        assert!(!is_game(r"C:\Games\StarCitizen\RSI Launcher.exe"));
        assert!(!is_game(r"C:\Tools\NotStarCitizen.exe"));
    }

    #[test]
    fn crop_to_the_monitor() {
        // Fullscreen on the second monitor (right of the first)
        let second = rect(3840, 0, 7680, 1600);
        assert_eq!(crop(rect(3840, 0, 7680, 1600), second), Some(Crop { x: 0, y: 0, width: 3840, height: 1600 }));
        // A window partly off the monitor: only the visible part
        assert_eq!(crop(rect(3700, 100, 4840, 900), second), Some(Crop { x: 0, y: 100, width: 1000, height: 800 }));
        // Monitor left of the primary (negative coordinates)
        assert_eq!(crop(rect(-1800, 50, -200, 950), rect(-1920, 0, 0, 1080)), Some(Crop { x: 120, y: 50, width: 1600, height: 900 }));
        // Outside
        assert_eq!(crop(rect(0, 0, 100, 100), second), None);
    }

    #[test]
    fn bgra_rows_with_padding() {
        // 2×2 pixels, rows padded to 12 bytes
        let data = [
            1, 2, 3, 255, 4, 5, 6, 255, 0, 0, 0, 0, //
            7, 8, 9, 255, 10, 11, 12, 255, 0, 0, 0, 0,
        ];
        assert_eq!(unpad(&data, 12, 2, 2), vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
    }
}
