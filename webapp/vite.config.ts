import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

// Dev: the backend runs as its own process (pnpm webapp); Vite proxies /api and /auth to it, so the
// browser sees one origin (WEBAPP_ORIGIN, http://localhost:5174) and the session cookie works.
// Open it as "localhost", not 127.0.0.1: the cookie and the OAuth redirect are bound to the host name.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL("..", import.meta.url)), "WEBAPP_");
  const backend = `http://127.0.0.1:${env.WEBAPP_PORT || "3002"}`;
  return {
    plugins: [vue()],
    server: {
      host: "localhost",
      port: 5174,
      strictPort: true,
      proxy: { "/api": backend, "/auth": backend },
    },
  };
});
