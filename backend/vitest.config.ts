import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: {
      JWT_SECRET: 'test-jwt-secret',
      SECRETS_KEY: 'oGkxLXhSTGGdzenXWYyLW9leHnJHUzlXY1YyY3ZJdEU=',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5434/swarmdev_test',
    },
    fileParallelism: false,
    // `npm run test:coverage`: the run-ownership and recovery modules must stay covered.
    coverage: {
      provider: 'v8',
      include: [
        'src/lib/child-env.ts',
        'src/modules/ownership/**/*.ts',
        'src/modules/hosts/launcher/launcher.ts',
        'src/modules/control-plane/run-token.ts',
        'src/modules/runs/run-ledger.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 90 },
    },
  },
});
