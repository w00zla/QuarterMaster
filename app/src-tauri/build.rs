// The app's own commands get permissions (`allow-<command>`), so the capabilities can grant each one to the splash or to
// the web app's origin and to nothing else (capabilities/*.json).
fn main() {
    const COMMANDS: &[&str] = &[
        "splash_state",
        "quit",
        "pick_folder",
        "pick_file",
        "open_external",
        "window_minimize",
        "window_toggle_maximize",
        "window_close",
        "window_is_maximized",
        "window_start_resize",
        "update_state",
        "update_check",
        "update_install",
        "update_set_channel",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build script failed");
}
