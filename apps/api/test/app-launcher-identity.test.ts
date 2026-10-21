import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_MCP_TOKEN, appLauncherPath, installManagedLauncher, isAppLauncher, isManagedLauncherCommand } from '../src/modules/harnesses/appMcpLauncher.js'

const runtime = process.execPath
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'execPath', { value: runtime })
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-launcher-identity-'))
  directories.push(directory)
  const source = join(directory, 'source.mjs')
  await writeFile(source, '// launcher')
  const nodeA = join(directory, 'node-a')
  const nodeB = join(directory, 'node-b')
  await writeFile(nodeA, 'runtime A')
  await writeFile(nodeB, 'runtime B')
  return { launcher: join(directory, 'launcher.mjs'), source: pathToFileURL(source), nodeA, nodeB, directory }
}

describe('managed launcher installation identity', () => {
  it.each(['GRAPHQL_APP_MCP_DIRECTORY', 'FOREMAN_CODE_APP_MCP_DIRECTORY'])(
    'installs a configured %s launcher and rejects the default installation', async name => {
      const original = appLauncherPath()
      const { directory, source } = await fixture()
      vi.stubEnv(name === 'GRAPHQL_APP_MCP_DIRECTORY' ? 'FOREMAN_CODE_APP_MCP_DIRECTORY' : 'GRAPHQL_APP_MCP_DIRECTORY', undefined)
      vi.stubEnv(name, directory)
      const installed = appLauncherPath()
      await installManagedLauncher(source, installed)
      expect(await readFile(installed, 'utf8')).toBe('// launcher')
      const entry = { command: process.execPath, args: [installed], env_vars: [APP_MCP_TOKEN] }
      expect(isAppLauncher(entry)).toBe(true)
      expect(isAppLauncher({ ...entry, args: [original] })).toBe(false)
    })

  it.each(['GRAPHQL_APP_MCP_DIRECTORY', 'FOREMAN_CODE_APP_MCP_DIRECTORY'])(
    'rejects a relative %s launcher directory', name => {
      vi.stubEnv(name === 'GRAPHQL_APP_MCP_DIRECTORY' ? 'FOREMAN_CODE_APP_MCP_DIRECTORY' : 'GRAPHQL_APP_MCP_DIRECTORY', undefined)
      for (const directory of ['', 'relative/mcp']) {
        vi.stubEnv(name, directory)
        expect(() => appLauncherPath()).toThrow('absolute directory')
      }
    })

  it('accepts matching launcher aliases and rejects conflicting installation targets', async () => {
    const { directory } = await fixture()
    vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', directory)
    vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', directory)
    expect(appLauncherPath()).toBe(join(directory, 'launcher.mjs'))
    vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', join(directory, 'other'))
    expect(() => appLauncherPath()).toThrow('conflicts')
  })

  it('recognizes the installed runtime after an API runtime change and preserves both installations', async () => {
    const { launcher, source, nodeA, nodeB } = await fixture()
    Object.defineProperty(process, 'execPath', { value: nodeA })
    await installManagedLauncher(source, launcher)
    Object.defineProperty(process, 'execPath', { value: nodeB })
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(true)
    await installManagedLauncher(source, launcher)
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(true)
    expect(isManagedLauncherCommand([nodeB, launcher], launcher)).toBe(true)
    expect(JSON.parse(await readFile(`${launcher}.installation.json`, 'utf8')).executables).toHaveLength(2)
    await rm(nodeA)
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(false)
  })

  it('does not trust custom executables, changed symlink targets or extra arguments', async () => {
    const { launcher, source, nodeA, nodeB, directory } = await fixture()
    const installed = join(directory, 'node')
    await symlink(nodeA, installed)
    Object.defineProperty(process, 'execPath', { value: installed })
    await installManagedLauncher(source, launcher)
    Object.defineProperty(process, 'execPath', { value: nodeB })
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(false)
    expect(isManagedLauncherCommand([installed, launcher, '--custom'], launcher)).toBe(false)
    await rm(installed)
    const attacker = join(directory, 'attacker')
    await writeFile(attacker, 'custom executable')
    await symlink(attacker, installed)
    expect(isManagedLauncherCommand([installed, launcher], launcher)).toBe(false)
  })

  it('migrates a legacy current-runtime install and recognizes its canonical alias', async () => {
    const { launcher, source, nodeA, nodeB, directory } = await fixture()
    Object.defineProperty(process, 'execPath', { value: nodeA })
    const alias = join(directory, 'alias')
    await symlink(nodeA, alias)
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(true)
    expect(isManagedLauncherCommand([alias, launcher], launcher)).toBe(true)
    expect(isManagedLauncherCommand([nodeB, launcher], launcher)).toBe(false)
    await installManagedLauncher(source, launcher)
    Object.defineProperty(process, 'execPath', { value: nodeB })
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(true)
  })

  it.each(['codex'] as const)('retains %s command and authentication restrictions', (harness) => {
    const entry = harness === 'codex'
      ? { command: process.execPath, args: [appLauncherPath()], env_vars: [APP_MCP_TOKEN] }
      : { type: 'local', command: [process.execPath, appLauncherPath()], environment: { [APP_MCP_TOKEN]: `{env:${APP_MCP_TOKEN}}` } }
    expect(isAppLauncher(entry)).toBe(true)
    expect(isAppLauncher({ ...entry, url: 'https://custom.invalid' })).toBe(false)
    expect(isAppLauncher({ ...entry, bearer_token_env_var: 'CUSTOM' })).toBe(false)
    expect(isAppLauncher({ ...entry, headers: { Authorization: 'custom' } })).toBe(false)
    expect(isAppLauncher({ ...entry, oauth: true })).toBe(false)
    expect(isAppLauncher(harness === 'codex'
      ? { ...entry, env: { CUSTOM: 'value' } }
      : { ...entry, environment: { [APP_MCP_TOKEN]: 'resolved', CUSTOM: 'value' } })).toBe(false)
  })
})
