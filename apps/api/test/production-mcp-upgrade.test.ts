import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  APP_MCP_TIMEOUTS, APP_MCP_TOKEN, appLauncherConnection, installManagedLauncher, isAppLauncher, readLauncherInstallation,
} from '../src/modules/harnesses/appMcpLauncher.js'
import { upgradeProductionMcpLauncher } from '../src/modules/harnesses/productionMcpUpgrade.js'
import { runLauncherProcess } from './helpers/launcherInstallationProcess.js'
import {
  applyMcpEdits, managedChange, managedEnableChange, managedStatus, mcpEdits, nativeConnection,
  type NativeMcpSnapshot,
} from '../src/modules/harnesses/nativeMcpCommon.js'

const directories: string[] = []
const runtime = process.execPath
const source = new URL('../../../scripts/graphql-mcp.mjs', import.meta.url)
afterEach(async () => {
  Object.defineProperty(process, 'execPath', { value: runtime })
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'production-mcp-upgrade-'))
  directories.push(home)
  const previous = join(home, '.local/state/graphql-production/mcp/launcher.mjs')
  const shared = join(home, '.local/share/graphql/mcp/launcher.mjs')
  vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', dirname(shared))
  await installManagedLauncher(source, previous)
  return { home, previous, shared }
}

it.each(['absent', 'empty-routes'] as const)(
  'refreshes a managed canonical launcher with %s legacy directories and retains its registrations', async legacy => {
    const { home, previous, shared } = await fixture()
    await rm(dirname(previous), { recursive: true })
    if (legacy === 'empty-routes') await mkdir(join(dirname(previous), 'routes'), { recursive: true })
    const installedRuntime = join(home, 'installed-node')
    await writeFile(installedRuntime, 'installed runtime')
    Object.defineProperty(process, 'execPath', { value: installedRuntime })
    await installManagedLauncher(source, shared)
    Object.defineProperty(process, 'execPath', { value: runtime })
    await writeFile(shared, 'process.stdout.write("obsolete launcher\\n")')
    expect(spawnSync(runtime, [shared], { encoding: 'utf8' }).stdout).toBe('obsolete launcher\n')

    await upgradeProductionMcpLauncher(home)

    const result = spawnSync(runtime, [shared], { input: 'invalid json\n', encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
    expect(readLauncherInstallation(shared)?.executables).toEqual(expect.arrayContaining([
      { path: installedRuntime, realpath: realpathSync(installedRuntime) },
      { path: runtime, realpath: realpathSync(runtime) },
    ]))
    expect(isAppLauncher({ command: installedRuntime, args: [shared], env_vars: [APP_MCP_TOKEN] })).toBe(true)
    await upgradeProductionMcpLauncher(home)
    expect(readLauncherInstallation(shared)?.executables).toHaveLength(2)
  },
)

it('does not refresh an unmanaged canonical launcher when legacy directories are absent', async () => {
  const { home, previous, shared } = await fixture()
  await rm(dirname(previous), { recursive: true })
  await mkdir(dirname(shared), { recursive: true })
  await writeFile(shared, '// custom launcher')
  await expect(upgradeProductionMcpLauncher(home)).rejects.toThrow('valid managed installation record')
  expect(await readFile(shared, 'utf8')).toBe('// custom launcher')
  expect(readLauncherInstallation(shared)).toBeUndefined()
})

it.each(['codex'] as const)(
  '%s retains its reviewed shared connection when the old production folder is unused', async () => {
    const { home, previous, shared } = await fixture()
    await rm(dirname(previous), { recursive: true })
    await mkdir(join(dirname(previous), 'routes'), { recursive: true })
    await installManagedLauncher(source, shared)
    const entry = nativeConnection(appLauncherConnection())
    await upgradeProductionMcpLauncher(home)
    expect(isAppLauncher(entry)).toBe(true)
    const uninstalled = nativeConnection({ ...appLauncherConnection(), arguments: [previous] })
    expect(isAppLauncher(uninstalled)).toBe(false)
    await upgradeProductionMcpLauncher(home)
    expect(isAppLauncher(entry)).toBe(true)
  },
)

it.each([
  ['codex', 'graphql', 'GRAPHQL_MCP_TOKEN'],
  ['codex', 'foreman-code', APP_MCP_TOKEN],
] as const)(
  '%s keeps existing %s credentials, disabled flags and policies through the upgrade and managed edits',
  async (harness, serverName, token) => {
    const { home, previous } = await fixture()
    const entry = {
      ...nativeConnection({
        ...appLauncherConnection(), arguments: [previous], environmentVariables: [token],
      }),
      enabled: false,
      enabled_tools: ['context_get'],
      disabled_tools: ['interaction_respond'],
      default_tools_approval_mode: 'prompt',
      tools: { context_get: { approval_mode: 'prompt' } },
      timeout: 5000,
      custom_setting: { retained: true },
    }
    const permission = { [`${serverName}_*`]: 'ask' }
    const snapshot: NativeMcpSnapshot = {
      harness, revision: 'revision', file: join(home, 'native-config'), version: '1',
      user: { [serverName]: entry }, effective: { [serverName]: entry },
      userConfig: { permission },
    }
    expect(isAppLauncher(entry)).toBe(false)
    await upgradeProductionMcpLauncher(home)
    expect(isAppLauncher(entry)).toBe(true)
    expect(managedStatus(snapshot, 'graphql')).toBe('disabled')
    const managed = { preset: 'graphql' as const, endpoint: 'http://127.0.0.1:3041/mcp' }
    const enabled = applyMcpEdits(snapshot.user, mcpEdits(snapshot, managedEnableChange('graphql', true), managed))
    expect(enabled).toEqual({ [serverName]: { ...entry, enabled: true,
      startup_timeout_sec: 60, tool_timeout_sec: APP_MCP_TIMEOUTS.tool_timeout_sec } })
    const enabledSnapshot = { ...snapshot, user: enabled, effective: enabled }
    expect(() => mcpEdits(enabledSnapshot, managedEnableChange('graphql', true), managed)).toThrow('matching')
    expect(applyMcpEdits(snapshot.user, mcpEdits(snapshot, managedChange('graphql', false, managed.endpoint), managed)))
      .toEqual({})
    const inherited = { ...snapshot, ownership: { [serverName]: false } }
    expect(managedStatus(inherited, 'graphql')).toBe('inherited')
    expect(() => mcpEdits(inherited, managedChange('graphql', false, managed.endpoint), managed)).toThrow('matching')
    await upgradeProductionMcpLauncher(home)
    expect(managedStatus(snapshot, 'graphql')).toBe('disabled')
    expect(snapshot.user).toEqual({ [serverName]: entry })
  },
)

it('retains both installed runtimes and its alias when the shared launcher is reinstalled', async () => {
  const { home, previous, shared } = await fixture()
  const installedRuntime = join(home, 'installed-node')
  await writeFile(installedRuntime, 'installed runtime')
  Object.defineProperty(process, 'execPath', { value: installedRuntime })
  await installManagedLauncher(source, previous)
  Object.defineProperty(process, 'execPath', { value: runtime })
  await installManagedLauncher(source, shared)
  await upgradeProductionMcpLauncher(home)
  const entry = { command: installedRuntime, args: [previous], env_vars: [APP_MCP_TOKEN] }
  expect(isAppLauncher(entry)).toBe(true)
  await installManagedLauncher(source, shared)
  expect(isAppLauncher(entry)).toBe(true)
  expect(isAppLauncher({ ...entry, command: runtime })).toBe(true)
  await rm(installedRuntime)
  expect(isAppLauncher(entry)).toBe(false)
})

it('resumes an upgrade interrupted after moving the original directory', async () => {
  const { home, previous } = await fixture()
  await rename(dirname(previous), `${dirname(previous)}.previous`)
  await upgradeProductionMcpLauncher(home)
  expect(isAppLauncher({ command: runtime, args: [previous], env_vars: [APP_MCP_TOKEN] })).toBe(true)
  await upgradeProductionMcpLauncher(home)
  expect(isAppLauncher({ command: runtime, args: [previous], env_vars: [APP_MCP_TOKEN] })).toBe(true)
})

it.each(['codex'] as const)(
  '%s native management recovers a lost transition registration from the retained installation', async harness => {
    const { home, previous, shared } = await fixture()
    await upgradeProductionMcpLauncher(home)
    // Recreate a completed transition without the separate registration record.
    await rm(`${shared}.registration.json`)
    await runLauncherProcess({ kind: 'older-install', launcher: shared })
    const entry = {
      ...nativeConnection({
        transport: 'stdio', executable: runtime, arguments: [previous], environmentVariables: [APP_MCP_TOKEN],
      }),
      enabled: false,
      enabled_tools: ['context_get'],
      disabled_tools: ['interaction_respond'],
    }
    const snapshot: NativeMcpSnapshot = {
      harness, revision: 'revision', file: join(home, 'native-config'), version: '1',
      user: { 'foreman-code': entry }, effective: { 'foreman-code': entry }, userConfig: {},
    }
    expect(isAppLauncher(entry)).toBe(false)
    await runLauncherProcess({ kind: 'upgrade', home })
    expect(managedStatus(snapshot, 'graphql')).toBe('disabled')
    const managed = { preset: 'graphql' as const, endpoint: 'http://127.0.0.1:3041/mcp' }
    const edits = mcpEdits(snapshot, managedEnableChange('graphql', true), managed)
    expect(applyMcpEdits(snapshot.user, edits)).toEqual({ 'foreman-code': { ...entry, enabled: true,
      startup_timeout_sec: 60, tool_timeout_sec: APP_MCP_TIMEOUTS.tool_timeout_sec } })
    expect(await runLauncherProcess({ kind: 'recognize', launcher: shared, entry })).toBe('true')
    await runLauncherProcess({ kind: 'older-install', launcher: shared })
    await runLauncherProcess({ kind: 'upgrade', home })
    expect(managedStatus(snapshot, 'graphql')).toBe('disabled')
  }, 30_000,
)

it('requires a managed retained installation before restoring an alias', async () => {
  const { home, previous, shared } = await fixture()
  await upgradeProductionMcpLauncher(home)
  await rm(`${shared}.registration.json`)
  await runLauncherProcess({ kind: 'older-install', launcher: shared })
  const retained = join(`${dirname(previous)}.previous`, 'launcher.mjs')
  await rm(`${retained}.installation.json`)
  await rm(`${retained}.registration.json`)
  const entry = { command: runtime, args: [previous], env_vars: [APP_MCP_TOKEN] }
  await expect(upgradeProductionMcpLauncher(home)).rejects.toThrow('valid managed installation record')
  expect(isAppLauncher(entry)).toBe(false)
}, 30_000)

it('requires a registered directory alias and retains command and authentication validation', async () => {
  const { home, previous, shared } = await fixture()
  await installManagedLauncher(source, shared)
  const unregistered = join(home, 'unregistered')
  await symlink(dirname(shared), unregistered)
  const entry = { command: runtime, args: [previous], env_vars: [APP_MCP_TOKEN] }
  expect(isAppLauncher({ ...entry, args: [join(unregistered, 'launcher.mjs')] })).toBe(false)
  await upgradeProductionMcpLauncher(home)
  expect(isAppLauncher({ ...entry, args: [previous, '--custom'] })).toBe(false)
  const customRuntime = join(home, 'custom-node')
  await writeFile(customRuntime, 'custom runtime')
  expect(isAppLauncher({ ...entry, command: customRuntime })).toBe(false)
  expect(isAppLauncher({ ...entry, env: { CUSTOM: 'value' } })).toBe(false)
  expect(isAppLauncher({ ...entry, bearer_token_env_var: 'CUSTOM' })).toBe(false)
  await rm(dirname(previous))
  const custom = join(home, 'custom')
  await mkdir(custom)
  await symlink(shared, join(custom, 'launcher.mjs'))
  await symlink(custom, dirname(previous))
  expect(isAppLauncher(entry)).toBe(false)
  await expect(upgradeProductionMcpLauncher(home)).rejects.toThrow('unmanaged installation')
})

it('does not adopt a production directory without a managed installation record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'production-mcp-custom-'))
  directories.push(home)
  const launcher = join(home, '.local/state/graphql-production/mcp/launcher.mjs')
  await mkdir(dirname(launcher), { recursive: true })
  await writeFile(launcher, '// custom launcher')
  await expect(upgradeProductionMcpLauncher(home)).rejects.toThrow('valid managed installation record')
})
