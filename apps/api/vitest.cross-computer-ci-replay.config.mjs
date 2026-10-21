import { defineConfig } from 'vitest/config'

// Offline replay has no application, credentials, database or resource provisioning.
export default defineConfig({
  test: { include: ['test/cross-computer-ci-replay.test.ts'], maxWorkers: 1 },
})
