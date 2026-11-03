// Build id for the cluster handshake: a hash over the source files (paths with /, line endings ignored), so the same
// source gives the same id on Windows and Linux and boxes with different builds are told apart
use std::fs;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=src");
    let mut files: Vec<_> = fs::read_dir("src").unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "rs")).collect();
    files.sort();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for f in &files {
        feed(Path::new(f).file_name().unwrap().to_string_lossy().as_bytes());
        let text = fs::read_to_string(f).unwrap().replace("\r\n", "\n");
        feed(text.as_bytes());
    }
    println!("cargo:rustc-env=PACKSHOT_BUILD={:08x}", h >> 32);
}
