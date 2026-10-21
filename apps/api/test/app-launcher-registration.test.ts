import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import {
  APP_MCP_TOKEN, installManagedLauncher, isAppLauncher, writeLauncherInstallation,
} from '../src/modules/harnesses/appMcpLauncher.js'
import { nativeConnection } from '../src/modules/harnesses/nativeMcpCommon.js'
import { runLauncherProcess } from './helpers/launcherInstallationProcess.js'

const directories: string[] = []
const source = new URL('../../../scripts/graphql-mcp.mjs', import.meta.url)
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(runtimeCount = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-registration-'))
  directories.push(directory)
  const launcher = join(directory, 'mcp/launcher.mjs')
  vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', dirname(launcher))
  await installManagedLauncher(source, launcher)
  const runtimes = Array.from({ length: runtimeCount }, (_, index) => join(directory, `node-${index}`))
  await Promise.all(runtimes.map(runtime => copyFile(process.execPath, runtime, constants.COPYFILE_FICLONE)))
  return { directory, launcher, runtimes }
}

it.each(['codex'] as const)(
  '%s registrations survive a stale metadata writer and recognition in a new process', async () => {
    const { directory, launcher, runtimes } = await fixture(2)
    const alias = join(directory, 'saved-mcp')
    await symlink(dirname(launcher), alias)
    const savedLauncher = join(alias, 'launcher.mjs')
    await runLauncherProcess({ kind: 'register', launcher, installation: {
      version: 1,
      executables: [{ path: runtimes[0]!, realpath: runtimes[0]! }],
      launcherAliases: [savedLauncher],
    } })
    const entry = nativeConnection({
      transport: 'stdio', executable: runtimes[0]!, arguments: [savedLauncher], environmentVariables: [APP_MCP_TOKEN],
    })
    await runLauncherProcess({ kind: 'older-install', launcher, snapshot: {
      version: 1, executables: [{ path: process.execPath, realpath: process.execPath }],
    } }, runtimes[1]!)
    expect(isAppLauncher(entry)).toBe(true)
    expect(await runLauncherProcess({ kind: 'recognize', launcher,  entry })).toBe('true')
  }, 30_000,
)

it('merges stale registrations and simultaneous installations through both directory names', async () => {
  const { directory, launcher, runtimes } = await fixture()
  const alias = join(directory, 'saved-mcp')
  await symlink(dirname(launcher), alias)
  const savedLauncher = join(alias, 'launcher.mjs')
  await Promise.all([
    runLauncherProcess({ kind: 'register', launcher, installation: {
      version: 1, executables: [], launcherAliases: [savedLauncher],
    } }),
    ...runtimes.map((runtime, index) => runLauncherProcess({
      kind: 'install', launcher: index % 2 ? savedLauncher : launcher,
    }, runtime)),
  ])
  const entries = runtimes.map(runtime => ({ command: runtime, args: [savedLauncher], env_vars: [APP_MCP_TOKEN] }))
  expect(JSON.parse(await runLauncherProcess({ kind: 'recognize', launcher, entry: entries })))
    .toEqual([true, true, true])
  // A caller may hold a snapshot from before the other installations completed.
  await writeLauncherInstallation(launcher, { version: 1, executables: [] })
  for (const runtime of runtimes) {
    expect(isAppLauncher({ command: runtime, args: [savedLauncher], env_vars: [APP_MCP_TOKEN] })).toBe(true)
  }
}, 30_000)

it('recognizes registered and unregistered commands together in a fresh process', async () => {
  const { launcher, runtimes } = await fixture()
  await writeLauncherInstallation(launcher, { version: 1,
    executables: [{ path: runtimes[0]!, realpath: runtimes[0]! }] })
  const entries = runtimes.map(runtime => ({ command: runtime, args: [launcher], env_vars: [APP_MCP_TOKEN] }))
  expect(JSON.parse(await runLauncherProcess({ kind: 'recognize', launcher, entry: entries })))
    .toEqual([true, false, false])
}, 30_000)

it('waits for another process and continues after its lock owner crashes', async () => {
  const { launcher, runtimes } = await fixture(1)
  const program = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const fd = fs.openSync(process.argv[1], 'r');
    cp.execFileSync('/usr/bin/flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    process.stdout.write('locked');
    setInterval(() => {}, 1000);
  `
  const owner = spawn(process.execPath, ['-e', program, dirname(launcher)], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(owner.stdout, 'data')
    let notifyStarted!: () => void
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const installation = runLauncherProcess({ kind: 'install', launcher }, runtimes[0]!, notifyStarted)
    await Promise.race([started, installation])
    // A short negative window checks that installation stays blocked by a live foreign lock.
    expect(await Promise.race([installation.then(() => 'finished'), delay(25, 'waiting')])).toBe('waiting')
    const exited = once(owner, 'exit')
    owner.kill('SIGKILL')
    await exited
    await installation
    const entry = { command: runtimes[0]!, args: [launcher], env_vars: [APP_MCP_TOKEN] }
    expect(await runLauncherProcess({ kind: 'recognize', launcher,  entry })).toBe('true')
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, 'exit')
      owner.kill('SIGKILL')
      await exited
    }
  }
}, 30_000)
