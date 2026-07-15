import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built SPA lands in site/ (served by the Python server). During dev the
// API is proxied to the local server on 8100.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'site', emptyOutDir: true },
  server: {
    port: 5273,
    proxy: {
      '/api': 'http://localhost:8100',
      '/healthz': 'http://localhost:8100',
    },
  },
});
