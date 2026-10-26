import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The Kokoro worker lazy-imports kokoro-js; code-splitting in a worker
  // needs ES module output.
  worker: { format: 'es' },
  server: {
    port: 5173,
    watch: {
      usePolling: true,
      interval: 300,
    },
    proxy: {
      '/ws': {
        target: 'ws://localhost:3173',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3173',
      },
    },
  },
});
