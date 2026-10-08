//! Windows screen capture for the refinery OCR: while detection is on and Star Citizen is the
//! foreground window, one frame per second of its client area, sent to the OCR worker (`ocrwatch`),
//! which gates and reads it; while detection is on it also tells whether the game runs at all
//! (`game-seen`, for the state row). DXGI Desktop Duplication: the image of the game's monitor, cut to the
//! window (no capture border, unlike Windows.Graphics.Capture on Windows 10). Window and monitor
//! coordinates are physical pixels: Tauri makes the process per-monitor DPI aware.

use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use image::RgbImage;
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
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetForegroundWindow, GetWindowThreadProcessId, IsIconic};

use crate::ocrwatch::{Detect, Frame, GameSeen, GAME_SEEN};

const GAME_EXE: &str = "StarCitizen.exe";
const INTERVAL: Duration = Duration::from_secs(1);
// Waiting for a desktop frame: the game presents continuously, a timeout means nothing changed
const ACQUIRE_TIMEOUT_MS: u32 = 200;

/// Starts the capture thread; it sends frames only while `detect` is on and the game is in front,
/// and tells whether the game runs (`seen`, only while `detect` is on).
pub fn spawn(app: AppHandle, tx: Sender<Frame>, detect: Detect, seen: GameSeen) {
    std::thread::spawn(move || {
        let mut dup: Option<Duplication> = None;
        let mut last_error = String::new();
        loop {
            std::thread::sleep(INTERVAL);
            let on = detect.load(Ordering::Relaxed);
            let hwnd = if on { game_window() } else { None };
            let running = on && (hwnd.is_some() || game_running());
            if seen.0.swap(running, Ordering::Relaxed) != running {
                let _ = app.emit(GAME_SEEN, running);
            }
            let Some(hwnd) = hwnd else {
                dup = None;
                continue;
            };
            match grab(&mut dup, hwnd) {
                Ok(Some(image)) => {
                    last_error.clear();
                    if tx.send(Frame { at_ms: now_ms(), image, live: true }).is_err() {
                        return;
                    }
                }
                Ok(None) => {}
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

/// The foreground window if it belongs to Star Citizen and is not minimized.
fn game_window() -> Option<HWND> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() || IsIconic(hwnd).as_bool() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let named = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(process);
        named.ok()?;
        is_game(&String::from_utf16_lossy(&buf[..len as usize])).then_some(hwnd)
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

/// One frame of the game window's client area; None when the desktop did not change.
fn grab(slot: &mut Option<Duplication>, hwnd: HWND) -> Result<Option<RgbImage>, String> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if slot.as_ref().is_none_or(|d| d.monitor != monitor) {
        *slot = None;
        let d = open(monitor)?;
        let r = d.desktop;
        log::debug!("screen capture on the monitor at ({}, {}), {}×{}", r.left, r.top, r.right - r.left, r.bottom - r.top);
        *slot = Some(d);
    }
    let d = slot.as_ref().expect("opened above");
    let Some(crop) = crop(client_rect(hwnd)?, d.desktop) else {
        return Ok(None);
    };
    d.frame(&crop)
}

fn client_rect(hwnd: HWND) -> Result<RECT, String> {
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
                return Ok(Duplication { monitor, desktop: desc.DesktopCoordinates, device, context, dup });
            }
        }
        Err("no DXGI output shows the game's monitor".into())
    }
}

impl Duplication {
    fn frame(&self, crop: &Crop) -> Result<Option<RgbImage>, String> {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;
            match self.dup.AcquireNextFrame(ACQUIRE_TIMEOUT_MS, &mut info, &mut resource) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
                Err(e) => return Err(format!("AcquireNextFrame: {e}")),
            }
            // No new desktop image (only the mouse pointer moved, or the black first frame)
            if info.LastPresentTime == 0 {
                let _ = self.dup.ReleaseFrame();
                return Ok(None);
            }
            let copied = self.copy(resource, crop);
            let _ = self.dup.ReleaseFrame();
            copied.map(Some)
        }
    }

    /// Copies the cropped part of the desktop image to the CPU as RGB.
    unsafe fn copy(&self, resource: Option<IDXGIResource>, c: &Crop) -> Result<RgbImage, String> {
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
        let mut staging = None;
        self.device.CreateTexture2D(&staging_desc, None, Some(&mut staging)).ctx("CreateTexture2D")?;
        let staging: ID3D11Texture2D = staging.ok_or("no staging texture")?;
        let source = D3D11_BOX { left: c.x, top: c.y, front: 0, right: c.x + c.width, bottom: c.y + c.height, back: 1 };
        self.context.CopySubresourceRegion(&staging, 0, 0, 0, 0, &texture, 0, Some(&source));
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        self.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).ctx("Map")?;
        let pitch = mapped.RowPitch as usize;
        let data = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * c.height as usize);
        let image = bgra_to_rgb(data, pitch, c.width, c.height);
        self.context.Unmap(&staging, 0);
        Ok(image)
    }
}

/// BGRA rows of `pitch` bytes (padded) to an RGB image.
fn bgra_to_rgb(data: &[u8], pitch: usize, width: u32, height: u32) -> RgbImage {
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for row in data.chunks(pitch).take(height as usize) {
        for px in row[..width as usize * 4].as_chunks::<4>().0 {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
    }
    RgbImage::from_raw(width, height, rgb).expect("width × height × 3 bytes")
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
        let img = bgra_to_rgb(&data, 12, 2, 2);
        assert_eq!(img.as_raw(), &vec![3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10]);
    }
}
