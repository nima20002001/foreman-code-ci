import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { remoteReviewEnvironment } from './helpers/remoteReviewEnvironment.js'

const execute = promisify(execFile)
const storageKeys = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'FOREMAN_CODE_APP_MCP_DIRECTORY']

it('keeps native fixture writes and session discovery separate from an installed Worker', async () => {
  const directory = await privateFixtureDirectory('remote-review-environment-')
  try {
    const installed = join(directory, 'installed')
    await mkdir(installed, { mode: 0o700 })
    const marker = join(installed, 'state.txt')
    await writeFile(marker, 'installed Worker state', { mode: 0o600 })
    const source: NodeJS.ProcessEnv = {
      ...process.env,
      ...Object.fromEntries(storageKeys.map(key => [key, installed])),
      PATH: join(installed, 'bin'),
      GRAPHQL_APP_MCP_DIRECTORY: installed,
      NODE_OPTIONS: `--require=${join(installed, 'loader.cjs')}`,
      NODE_PATH: installed,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${installed}/bus`,
    }
    const before = { ...source }
    const home = join(directory, 'fixture')
    const environment = remoteReviewEnvironment(home, join(home, 'claude'),
      join(home, 'mcp', 'launcher.mjs'), source)
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
      import { mkdir, writeFile } from 'node:fs/promises'
      import { join } from 'node:path'
      for (const key of ${JSON.stringify(storageKeys)}) {
        await mkdir(process.env[key], { recursive: true, mode: 0o700 })
        await writeFile(join(process.env[key], 'state.txt'), 'fixture state', { mode: 0o600 })
      }
      process.stdout.write(JSON.stringify({
        path: process.env.PATH,
        bus: process.env.DBUS_SESSION_BUS_ADDRESS,
        legacyMcp: process.env.GRAPHQL_APP_MCP_DIRECTORY ?? null,
        nodeOptions: process.env.NODE_OPTIONS ?? null,
        nodePath: process.env.NODE_PATH ?? null,
      }))
    `], { env: environment })
    const discovery = JSON.parse(stdout) as {
      path: string; bus: string; legacyMcp: string | null; nodeOptions: string | null; nodePath: string | null
    }
    expect(discovery.path.split(':')).not.toContain(source.PATH)
    expect(discovery.bus).not.toBe(source.DBUS_SESSION_BUS_ADDRESS)
    expect(discovery.bus).toBe(`unix:path=${environment.XDG_RUNTIME_DIR}/bus`)
    expect(discovery.legacyMcp).toBeNull()
    expect(discovery.nodeOptions).toBeNull()
    expect(discovery.nodePath).toBeNull()
    for (const key of storageKeys) {
      expect(await readFile(join(environment[key]!, 'state.txt'), 'utf8')).toBe('fixture state')
    }
    expect(await readFile(marker, 'utf8')).toBe('installed Worker state')
    expect(source).toEqual(before)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
