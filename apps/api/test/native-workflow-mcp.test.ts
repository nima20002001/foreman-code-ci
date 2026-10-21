import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { appLauncherPath, isAppLauncher } from '../src/modules/harnesses/appMcpLauncher.js'
import { configureNativeWorkflowMcp } from './helpers/nativeWorkflowMcp.js'

const source = vi.hoisted(() => ({ name: '', token: '', command: [] as string[] }))

vi.mock('../src/modules/harnesses/codexMcpConnections.js', () => ({
  CodexMcpConnections: class {
    async read() {
      return { effective: { [source.name]: {
        command: source.command[0], args: [source.command[1]], env_vars: [source.token],
      } } }
    }
  },
}))

const storageFixtures = [
  { name: 'graphql', token: 'GRAPHQL_MCP_TOKEN' },
  { name: 'foreman-code', token: 'FOREMAN_CODE_MCP_TOKEN' },
].flatMap(identity => ['direct', 'isolated', 'copied', 'relocated'].map(storage => ({ ...identity, storage })))

it.each(storageFixtures)('keeps the $token reference in $storage native storage', async (identity) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-workflow-source-'))
  const previousHome = process.env.CODEX_HOME
  const previousLauncherDirectory = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
  const previousSourceLauncher = process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY
  const previousAuthentication = process.env.FOREMAN_CODE_TEST_CODEX_AUTH_FILE
  let restore: (() => Promise<void>) | undefined
  try {
    const home = join(directory, 'source-home')
    const projectDirectory = join(directory, 'project')
    await mkdir(home, { mode: 0o700 })
    await mkdir(projectDirectory, { mode: 0o700 })
    const sourceConfig = 'model = "source-profile-model"\n'
    await writeFile(join(home, 'config.toml'), sourceConfig, { mode: 0o600 })
    await writeFile(join(home, 'auth.json'), JSON.stringify({ fixture: true }), { mode: 0o600 })
    process.env.CODEX_HOME = home
    process.env.FOREMAN_CODE_TEST_CODEX_AUTH_FILE = join(home, 'auth.json')
    process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(directory, 'source-launcher')
    source.name = identity.name
    source.token = identity.token
    source.command = [process.execPath, appLauncherPath()]
    if (identity.storage === 'isolated') {
      process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
      process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(directory, 'outer-storage-mcp')
    } else {
      delete process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY
      if (identity.storage === 'copied') {
        process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(directory, 'copied-launcher')
      }
    }
    if (identity.storage === 'relocated') {
      process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(directory, 'relocated-launcher')
    }
    const restoredLauncherDirectory = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY

    restore = await configureNativeWorkflowMcp({ projectDirectory,
      runtimeDirectory: join(directory, 'runtime'), codexBinary: 'recorded' })
    const ownedHome = process.env.CODEX_HOME!
    const configuration = await readFile(join(ownedHome, 'config.toml'), 'utf8')
    const lines = configuration.trim().split('\n')
    expect(lines[0]).toBe(`[mcp_servers.${identity.name}]`)
    const entry = Object.fromEntries(lines.slice(1).map(line => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator).trim(), JSON.parse(line.slice(separator + 1).trim()) as unknown]
    }))
    expect(entry).toEqual({ command: process.execPath, args: [appLauncherPath()], env_vars: [identity.token] })
    expect(isAppLauncher(entry)).toBe(true)
    expect(JSON.parse(await readFile(join(ownedHome, 'auth.json'), 'utf8'))).toEqual({ fixture: true })
    await restore()
    restore = undefined
    expect(process.env.CODEX_HOME).toBe(home)
    expect(process.env.FOREMAN_CODE_APP_MCP_DIRECTORY).toBe(restoredLauncherDirectory)
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(sourceConfig)
    await expect(access(ownedHome)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    try { await restore?.() }
    finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousHome
      if (previousLauncherDirectory === undefined) delete process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
      else process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = previousLauncherDirectory
      if (previousSourceLauncher === undefined) delete process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY
      else process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY = previousSourceLauncher
      if (previousAuthentication === undefined) delete process.env.FOREMAN_CODE_TEST_CODEX_AUTH_FILE
      else process.env.FOREMAN_CODE_TEST_CODEX_AUTH_FILE = previousAuthentication
      await rm(directory, { recursive: true, force: true })
    }
  }
})
