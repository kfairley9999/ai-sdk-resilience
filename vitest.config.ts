import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The playground Worker imports the built package. Tests point it at the source instead,
    // so they do not need a prior build.
    alias: [{ find: /^\.\.\/\.\.\/dist\/index\.js$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'playground/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/types.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
