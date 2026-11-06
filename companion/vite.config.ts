import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = process.env.TAURI_DEV_HOST;

// Tauri runs Vite on a fixed port (tauri.conf.json devUrl); 1430 keeps clear of BindSight's 1420.
export default defineConfig(() => ({
  plugins: [vue()],
  // Rust errors stay visible in `tauri dev`
  clearScreen: false,
  // Three pages: the app, the debug window and the scan overlay
  build: { rollupOptions: { input: { main: "index.html", debug: "debug.html", overlay: "overlay.html" } } },
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
