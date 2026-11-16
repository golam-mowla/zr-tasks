import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { rollupOptions: { input: { main: resolve('index.html'), popup: resolve('popup.html') } } },
});
