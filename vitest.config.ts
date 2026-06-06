import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['electron/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@electron': resolve(__dirname, 'electron'),
    },
  },
  define: {
    'window': 'undefined',
    'document': 'undefined',
  },
});
