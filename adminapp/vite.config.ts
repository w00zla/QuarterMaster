import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

// Dev: the API runs as its own process (pnpm adminapp); Vite proxies /api to it.
// Settings come from the repo root's .env, like the backend's.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL("..", import.meta.url)), "ADMINAPP_");
  return {
    plugins: [vue(), ...(command === "serve" ? [basicAuth(env.ADMINAPP_USER, env.ADMINAPP_PASSWORD)] : [])],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: { "/api": `http://127.0.0.1:${env.ADMINAPP_PORT || "3000"}` },
    },
  };
});

// The dev server asks for the same basic auth as the backend: the browser then
// prompts once on page load and sends the credentials with every /api request,
// which the proxy passes on. Without it, the API's 401 on fetch() never prompts.
function basicAuth(user: string | undefined, password: string | undefined): Plugin {
  if (!user || !password) throw new Error("ADMINAPP_USER and ADMINAPP_PASSWORD must be set in the repo's .env");
  const expected = Buffer.from(`Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`);
  return {
    name: "basic-auth",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const given = Buffer.from(req.headers.authorization ?? "");
        if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Basic realm="SC Quartermaster"');
        res.end("Unauthorized");
      });
    },
  };
}
