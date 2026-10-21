import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { appLauncherPath, isAppLauncher, readLauncherInstallation } from '../src/modules/harnesses/appMcpLauncher.js'
import { managedStatus, replacement, managedChange, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import { registerWorkerMcpInstallation } from '../src/modules/harnesses/workerMcpInstallation.js'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { NativeManagerResolutionContext } from '../src/modules/interactions/runtimePorts.js'
import { remoteMcpPreflight } from '../src/modules/placement/remoteMcpPreflight.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'worker-mcp-installation-'))
  directories.push(home)
  const root = join(home, '.local/lib/graphql-worker')
  const stateDirectory = join(home, '.local/state/graphql-worker')
  const releaseDirectory = join(root, 'versions/release')
  const launcher = join(home, '.local/share/graphql/mcp/launcher.mjs')
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 })
  await mkdir(join(releaseDirectory, 'artifacts'), { recursive: true, mode: 0o700 })
  await writeFile(join(releaseDirectory, 'artifacts/graphql-mcp.mjs'), '// managed bridge', { mode: 0o600 })
  await writeFile(launcher, '// managed bridge', { mode: 0o600 })
  const previousNode = join(home, 'previous-node')
  await copyFile(process.execPath, previousNode)
  const service = `ExecStart=${previousNode} ${join(root, 'current/src/cli.mjs')} run --state ${stateDirectory}\n`
  await writeFile(join(root, 'graphql-worker.service.previous'), service, { mode: 0o600 })
  vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', dirname(launcher))
  const entry = { command: previousNode, args: [launcher], env_vars: ['GRAPHQL_MCP_TOKEN'], enabled: false,
    disabled_tools: ['interaction_respond'] }
  return { home, root, stateDirectory, releaseDirectory, launcher, previousNode, service, entry }
}

it('recovers an unrecorded installed interpreter after an update and retains it across restarts', async () => {
  const f = await fixture()
  expect(isAppLauncher(f.entry)).toBe(false)
  await registerWorkerMcpInstallation(f)
  expect(appLauncherPath()).toBe(f.launcher)
  expect(isAppLauncher(f.entry)).toBe(true)
  const snapshot: NativeMcpSnapshot = { harness: 'codex', file: join(f.home, 'config.toml'), version: '1',
    revision: 'revision', userConfig: {}, user: { graphql: f.entry }, effective: { graphql: f.entry } }
  expect(managedStatus(snapshot, 'graphql')).toBe('disabled')
  const repaired = replacement(snapshot, managedChange('graphql', true, ''), { preset: 'graphql', endpoint: '' })
  expect(repaired).toMatchObject({ command: process.execPath, enabled: false,
    disabled_tools: f.entry.disabled_tools })
  await registerWorkerMcpInstallation(f)
  expect(readLauncherInstallation(f.launcher)?.executables).toHaveLength(2)
  expect(isAppLauncher(f.entry)).toBe(true)
  const foreignNode = join(f.home, 'foreign-node')
  await copyFile(process.execPath, foreignNode)
  expect(isAppLauncher({ ...f.entry, command: foreignNode })).toBe(false)
  expect(isAppLauncher({ ...f.entry, env: { CUSTOM: 'value' } })).toBe(false)
  expect(isAppLauncher({ ...f.entry, args: [f.launcher, '--custom'] })).toBe(false)
})

it('refreshes a matching retained bridge during automatic Worker update', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'previous/artifacts'), { recursive: true, mode: 0o700 })
  await writeFile(join(f.root, 'previous/artifacts/graphql-mcp.mjs'), '// previous bridge', { mode: 0o600 })
  await writeFile(f.launcher, '// previous bridge', { mode: 0o600 })
  await registerWorkerMcpInstallation(f)
  expect(await readFile(f.launcher, 'utf8')).toBe('// managed bridge')
  expect(isAppLauncher(f.entry)).toBe(true)
})

it('unblocks paired-computer preflight after startup registers its previous interpreter', async () => {
  const f = await fixture()
  const input = { harness: 'codex' as const, runnerId: 'worker-runner', workingDirectory: f.home }
  const detection = new McpDetectionService({ inspect: async () => ({
    ...input, providerVersion: 'fixture', inspectedAt: new Date().toISOString(),
    entry: { name: 'graphql', transport: 'stdio', enabled: true,
      automaticEndpoint: isAppLauncher({ ...f.entry, enabled: true }),
      credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN' },
  }) }, 'https://app.invalid/mcp')
  const manager = { harness: 'codex', inspectMcp: async () => (await detection.inspect(input)).detection,
    capabilities: async () => ({ provider: 'codex', providerVersion: 'fixture' }) }
  const preflight = remoteMcpPreflight(manager as unknown as NativeHarnessSessionManager,
    input as unknown as NativeManagerResolutionContext)
  await expect(preflight.preflight(input)).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_FAILED' })
  await registerWorkerMcpInstallation(f)
  expect(await preflight.preflight(input)).toMatchObject({
    detection: { serverName: 'graphql', state: 'status_unavailable', endpointMatches: true },
  })
})

it('leaves customized launchers and foreign service commands unmanaged', async () => {
  const f = await fixture()
  await writeFile(f.launcher, '// custom bridge', { mode: 0o600 })
  await registerWorkerMcpInstallation(f)
  expect(readLauncherInstallation(f.launcher)).toBeUndefined()
  expect(await readFile(f.launcher, 'utf8')).toBe('// custom bridge')
  await writeFile(f.launcher, '// managed bridge', { mode: 0o600 })
  await writeFile(join(f.root, 'graphql-worker.service.previous'),
    f.service.replace(join(f.root, 'current/src/cli.mjs'), join(f.home, 'foreign/cli.mjs')), { mode: 0o600 })
  await registerWorkerMcpInstallation(f)
  expect(isAppLauncher(f.entry)).toBe(false)
  expect(readLauncherInstallation(f.launcher)?.executables).toHaveLength(1)
})

it('rejects inherited and customized native settings after recording the installed interpreter', async () => {
  const f = await fixture()
  await registerWorkerMcpInstallation(f)
  const user = { graphql: f.entry }
  const snapshot: NativeMcpSnapshot = { harness: 'codex', file: join(f.home, 'config.toml'), version: '1',
    revision: 'revision', userConfig: {}, user, effective: user, ownership: { graphql: false } }
  expect(managedStatus(snapshot, 'graphql')).toBe('inherited')
  const change = managedChange('graphql', true, '')
  expect(() => replacement(snapshot, change, { preset: 'graphql', endpoint: '' })).toThrow('already has')
  const custom = { graphql: { ...f.entry, env: { CUSTOM: 'value' } } }
  expect(() => replacement({ ...snapshot, user: custom, effective: custom, ownership: {} }, change,
    { preset: 'graphql', endpoint: '' })).toThrow('custom transport')
})
