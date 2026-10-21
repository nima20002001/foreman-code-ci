import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  failure: new Error('Test path must remain inside its owned root'),
  errors: [] as { message: string; error: unknown }[],
}))

vi.mock('@foreman-code/contracts/product-environment-node', () => ({ loadProductEnvFile: () => undefined }))
vi.mock('../src/config.js', () => ({ loadConfig: () => ({}) }))
vi.mock('../src/infrastructure/testRuntimeResources.js', () => ({ readTestResourcesIdentity: () => {
  throw state.failure
} }))
vi.mock('../src/infrastructure/logger.js', () => ({
  enableFileLogging: async () => undefined,
  componentLogger: () => ({
    fatal: (context: { err: unknown }, message: string) => state.errors.push({ message, error: context.err }),
  }),
}))
vi.mock('../src/infrastructure/processLifecycle.js', () => ({ installProcessLifecycleLogging: () => undefined }))
vi.mock('../src/production.js', () => {
  throw new Error('Workflow runtime dependency is unavailable')
})

it('reports invalid resource ownership before loading unavailable runtime dependencies', async () => {
  const previousExitCode = process.exitCode
  vi.stubEnv('FOREMAN_CODE_TEST_ROOT', '/fixture/test-root')
  try {
    await import('../src/server.js')
    await vi.waitFor(() => expect(state.errors).toEqual([{ message: 'api failed to start', error: state.failure }]))
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = previousExitCode
    vi.unstubAllEnvs()
  }
})
