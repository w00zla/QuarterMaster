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
    // Only what the app imports (styles and components shared with the web apps)
    fs: { allow: [".", "../adminapp/src", "../webapp/src/styles.css", "../webapp/src/components/ConfirmDialog.vue", "../webapp/src/components/Picker.vue", "../webapp/src/components/ColumnsButton.vue", "../webapp/src/components/ViewToggle.vue", "../webapp/src/components/ColumnsDialog.vue", "../src/webapp/api-types.ts", "../src/thumbs.ts", "../src/stock/material-names.ts", "../src/stock/component-stats.ts", "../src/stock/quality.ts", "../src/catalog/components.ts"] },
  },
}));
