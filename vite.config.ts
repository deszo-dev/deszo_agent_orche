import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Browser development reads the standalone runner's connection file (npm run runner).
export default defineConfig({
  plugins: [react(), {
    name: 'local-runner-connection',
    configureServer(server) {
      server.middlewares.use('/__runner/connection', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          res.end(await readFile(resolve(process.env.DESZO_CONNECTION || '.deszo/runtime/connection.json'), 'utf8'));
        } catch {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Start the runtime with npm run runner or npm run desktop.' }));
        }
      });
    },
  }],
  clearScreen: false,
  server: {
    host: '127.0.0.1', port: 1420, strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/.deszo/**', '**/.deszo-fixture/**', '**/dist-runtime/**', '**/.hello-*/**'] },
  },
});
