import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the ciurma UI. Root is src/ui, output goes to dist/ui so the hub
// can serve it as static files alongside the compiled server code in dist/.
export default defineConfig({
  root: 'src/ui',
  plugins: [react()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
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
