import { homedir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { appLauncherConnection, isAppLauncher } from '../src/modules/harnesses/appMcpLauncher.js'

afterEach(() => vi.unstubAllEnvs())

it.each(['codex'] as const)('production routing recognizes the reviewed %s launcher', async harness => {
  vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', undefined)
  const reviewed = appLauncherConnection()
  const runtimeModule = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
  const { localProductionEnvironment } = await import(runtimeModule)
  const environment = localProductionEnvironment(homedir(), 'a'.repeat(64))
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', environment.FOREMAN_CODE_APP_MCP_DIRECTORY)
  const entry = harness === 'codex'
    ? { command: reviewed.executable, args: reviewed.arguments, env_vars: ['GRAPHQL_MCP_TOKEN'] }
    : { type: 'local', command: [reviewed.executable, ...reviewed.arguments],
      environment: { GRAPHQL_MCP_TOKEN: '{env:GRAPHQL_MCP_TOKEN}' } }
  expect(isAppLauncher(entry)).toBe(true)
})
