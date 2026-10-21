import { defineConfig } from 'vitest/config'
import { env } from 'node:process'

const configuredWorkers = env.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS
const maxWorkers = configuredWorkers === undefined ? 4 : Number(configuredWorkers)
if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 256) {
  throw new Error('Verification unit workers must be an integer from 1 to 256')
}

export default defineConfig({
  test: {
    ...(env.CI_PROGRESS_FILE ? { runner: '../../packages/contracts/ci-test-runner.mjs', reporters: ['default', '../../scripts/ci-progress-reporter.mjs'] } : {}),
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs', '../../scripts/vitest-test-resources.mjs'],
    setupFiles: ['./test/setupCoverage.ts', './test/setupResources.ts'],
    sequence: { setupFiles: 'list' },
    // Leave CPU headroom for the Vitest coordinator and application processes.
    maxWorkers,
    // Many cases start real processes, Postgres sessions or MCP servers; under a full gate the 5 s default
    // times out heavy cases at random (2026-10-09 gates).
    testTimeout: 20_000,
    // Every integration file runs in its own Vitest process; sharing compiled modules on disk skips most of each
    // process's cold transform. CI computers point it at a cache that outlives the run's worktree.
    fsModuleCache: true,
    ...(env.FOREMAN_CODE_VITEST_CACHE ? { fsModuleCachePath: env.FOREMAN_CODE_VITEST_CACHE } : {}),
  },
})
