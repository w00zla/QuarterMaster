// No console window beside the app in a release build on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    quartermaster_lib::run()
}
