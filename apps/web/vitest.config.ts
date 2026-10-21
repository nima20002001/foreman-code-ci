import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

const configuredWorkers = process.env.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS
const maxWorkers = configuredWorkers === undefined ? 4 : Number(configuredWorkers)
if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 256) {
  throw new Error('Verification unit workers must be an integer from 1 to 256')
}

// Two phases: "fast" runs everything but the load-sensitive suites at full width; "heavy" runs only those, last,
// with few workers and longer timeouts. Unset runs everything at once (single-file and ad-hoc runs).
const heavy = JSON.parse(readFileSync(new URL('./heavy-tests.json', import.meta.url), 'utf8')) as { files: string[]; workers: number; timeoutMs: number }
const phase = process.env.FOREMAN_WEB_TEST_PHASE
if (phase !== undefined && phase !== 'fast' && phase !== 'heavy') throw new Error('FOREMAN_WEB_TEST_PHASE must be fast or heavy')

export default defineConfig({
  define: { __RUNTIME_BUILD_IDENTITY__: JSON.stringify({ version: 1, buildId: 'a'.repeat(64), contractsId: 'b'.repeat(64) }) },
  plugins: [react(), tailwindcss()],
  test: {
    ...(process.env.CI_PROGRESS_FILE ? { runner: '../../packages/contracts/ci-test-runner.mjs', reporters: ['default', '../../scripts/ci-progress-reporter.mjs'] } : {}),
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs'],
    // Leave CPU headroom for the Vitest coordinator and jsdom.
    maxWorkers: phase === 'heavy' ? Math.min(maxWorkers, heavy.workers) : maxWorkers,
    environment: 'jsdom',
    globals: true,
    include: phase === 'heavy' ? heavy.files : ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: phase === 'fast' ? ['**/node_modules/**', ...heavy.files] : ['**/node_modules/**'],
    ...(phase === 'heavy' ? { testTimeout: heavy.timeoutMs, hookTimeout: heavy.timeoutMs } : {}),
    setupFiles: ['./src/test/setup.ts'],
    fsModuleCache: true,
    css: true,
    passWithNoTests: false,
  },
})
