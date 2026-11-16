import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The web app, built into dist/web/app, where the Wheems service serves it. `npm run dev:web`
 * serves it with live reload, passing /api to a running Wheems (WHEEMS_WEB_PORT, or 4317).
 */
const WHEEMS = `http://127.0.0.1:${process.env.WHEEMS_WEB_PORT ?? '4317'}`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web/app', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    // To the running Wheems, as if from its own page (its Host and Origin), which it requires.
    proxy: {
      '/api': {
        target: WHEEMS,
        changeOrigin: true,
        headers: { origin: WHEEMS },
      },
    },
  },
});
