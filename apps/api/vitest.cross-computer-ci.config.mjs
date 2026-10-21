import { defineConfig } from 'vitest/config'

// This scenario talks to an already-running production Main and needs no local app or test database.
export default defineConfig({
  test: {
    include: ['test/cross-computer-ci.acceptance.test.ts'],
    maxWorkers: 1,
    testTimeout: 9 * 60 * 60_000,
  },
})
