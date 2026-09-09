/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // The dev/preview servers must accept the sandbox preview proxy host.
  server: {
    host: true,
    allowedHosts: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    allowedHosts: true,
  },
  // The simulation worker is bundled as its own ES module chunk so that no
  // simulation-core runtime code is ever pulled into the main bundle.
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
