import { defineConfig } from 'vitest/config';
export default defineConfig({
  define: { __VERSION__: JSON.stringify('0.0.0-test') },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30000 },
});
