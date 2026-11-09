import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['test/e2e/**', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/feat-001',
      reporter: ['text', 'json', 'lcov'],
      include: [
        'src/shared/ttsSettings.ts',
        'src/dsh/runtime.ts',
        'src/dsh/index.ts',
        'src/dsh/agent.ts',
        'src/body/macosTts.ts',
        'src/body/yovoiceTts.ts',
        'src/console/console.tsx',
      ],
    },
  },
});
