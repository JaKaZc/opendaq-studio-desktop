import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Where the engine's development server (`make serve`) listens. */
const BACKEND = process.env.OPENDAQ_STUDIO_BACKEND ?? 'http://127.0.0.1:8420';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The bundle is always served from the site root: from studio://app/ in the
  // desktop app, and by Vite or the engine's development server while
  // developing. Absolute asset URLs keep working when the SPA fallback serves
  // index.html for an unknown path.
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Keep React in its own chunk: it changes far less often than app code,
        // so a rebuild does not invalidate it in the browser cache.
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Proxy so the dev UI talks to the real backend on the same origin, which
    // keeps CORS and WebSocket URLs identical to production.
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
});
