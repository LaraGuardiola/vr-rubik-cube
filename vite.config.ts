import { defineConfig } from 'vite';

// Default dev server: plain HTTP. This is the easiest way to open the app from
// a Quest 2 (or any device) on the same Wi-Fi — the headset browser will load
// http://<your-lan-ip>:5173 without certificate warnings.
//
// NOTE: WebXR requires a secure context. http://localhost is treated as secure
// by browsers, but http://<lan-ip> is NOT — so WebXR (the Enter AR/VR buttons)
// may be unavailable over plain http from another device. For WebXR on the
// headset, use `bun run dev:https` (self-signed cert) or a tunnel, or open
// http://localhost:5173 on the Quest via `adb reverse tcp:5173 tcp:5173`.
// See AGENTS.md.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  // Relative asset paths so the production build works under any URL path —
  // e.g. a GitHub Pages project site at https://<user>.github.io/<repo>/.
  base: './',
  build: {
    target: 'es2022',
    // Output to docs/ so GitHub Pages can deploy it directly from the main
    // branch ("Deploy from a branch" → folder /docs) — no Actions needed.
    outDir: 'docs',
  },
});
