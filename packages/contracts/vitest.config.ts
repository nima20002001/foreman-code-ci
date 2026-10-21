import { configDefaults, defineConfig } from 'vitest/config'

const configuredWorkers = process.env.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS
const maxWorkers = configuredWorkers === undefined ? 12 : Number(configuredWorkers)
if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 256) {
  throw new Error('Verification unit workers must be an integer from 1 to 256')
}

export default defineConfig({
  test: {
    ...(process.env.CI_PROGRESS_FILE ? { runner: './ci-test-runner.mjs', reporters: ['default', '../../scripts/ci-progress-reporter.mjs'] } : {}),
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs'],
    // Leave CPU headroom for the Vitest coordinator and application processes.
    maxWorkers,
    fsModuleCache: true,
    // Ignore compiled tests left by older builds.
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
})
