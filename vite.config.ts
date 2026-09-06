import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vite config for the pensiero UI. Root is src/ui, output goes to dist/ui so the hub
// can serve it as static files alongside the compiled server code in dist/.
export default defineConfig({
  root: fileURLToPath(new URL('./src/ui', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
  },
  // vitest reads this file too: without its own root it would look for tests under src/ui.
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['src/**/*.test.ts'],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4177',
      '/ws': {
        target: 'ws://localhost:4177',
        ws: true,
      },
    },
  },
});
