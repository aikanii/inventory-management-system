import { defineConfig } from 'vitest/config';

// The API client is framework-free, so it is tested in a plain node environment
// with `fetch` and `localStorage` stubbed — no DOM, no React, no network.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
