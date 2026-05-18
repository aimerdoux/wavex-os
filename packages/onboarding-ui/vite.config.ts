import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Onboarding UI runs at localhost:5173 by default.
// `npx wavex-os init` opens the browser here after `pnpm dev` boots the wizard.
// API calls go to the local Paperclip core (localhost:3100) and the hosted backend
// (api.wavex-os.dev — TBD) via the onboarding-server-client package.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // If another dev session already owns 5173, let Vite continue on the next
    // available port instead of exiting before contributors see the wizard.
    strictPort: false,
    // Bind explicitly to 127.0.0.1 (IPv4) — macOS Vite defaults to IPv6-only,
    // which can prevent localhost connections from tooling that prefers IPv4.
    host: "127.0.0.1",
    // Allow any Host header so cloudflared / ngrok tunnels pass through.
    allowedHosts: true,
    open: false, // installer opens the browser; vite shouldn't double-open
    proxy: {
      // Anchored to `/api/paperclip/<subpath>` — requires the trailing
      // slash so neighboring paths like `/api/paperclip-reachable`
      // (server-side Paperclip-up probe) don't get wrongly matched and
      // rewritten to `/api-reachable`, which 404s. Without this anchor
      // the InceptionCTA's "Open Paperclip Dashboard ↗" button stayed
      // disabled forever even when Paperclip was healthy. See
      // BUG.PROXY_REWRITE in the 2026-05-13 E2E QA report.
      "^/api/paperclip/": {
        target: process.env.WAVEX_CORE_URL ?? "http://127.0.0.1:3101",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/paperclip\//, "/api/"),
      },
      "/api": {
        target: process.env.WAVEX_CORE_URL ?? "http://127.0.0.1:3101",
        changeOrigin: true,
      },
      "/wavex-os": {
        target: process.env.WAVEX_CORE_URL ?? "http://127.0.0.1:3101",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
