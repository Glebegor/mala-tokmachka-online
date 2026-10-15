import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // reachable through `tailscale serve` (https://<machine>.<tailnet>.ts.net)
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
