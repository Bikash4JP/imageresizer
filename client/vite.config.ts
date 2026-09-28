/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in development too, so the app never needs CORS locally.
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    // Do not publish source maps to the public bucket.
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
