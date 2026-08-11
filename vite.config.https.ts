import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Optional HTTPS dev server (WebXR needs a secure context on remote devices).
// Self-signed cert generated on the fly; the headset browser must be told to
// trust it, or use a tunnel that provides a real cert. Run with:
//   bun run dev:https
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
    port: 5173,
    https: true,
  },
  // Relative asset paths so the production build works under any URL path
  // (e.g. GitHub Pages project sites).
  base: './',
  build: {
    target: 'es2022',
  },
});
