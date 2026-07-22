import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server runs on 5173 and proxies /api to the Express backend on 8000,
// so the frontend can call the API on a same-origin path without CORS in dev.
//
// When VITE_BEHIND_PROXY=1 (npm run dev:proxy), the dev server is being fronted
// by an HTTPS reverse proxy (nginx) on a real hostname:
//   - allowedHosts: true  → accept the proxied Host header
//   - hmr over wss on 443 → live-reload works through the TLS proxy
// No hostname is hardcoded here; the proxy host is configured in nginx.
const behindProxy = process.env.VITE_BEHIND_PROXY === '1';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
    ...(behindProxy && {
      allowedHosts: true,
      hmr: { clientPort: 443, protocol: 'wss' },
    }),
  },
});
