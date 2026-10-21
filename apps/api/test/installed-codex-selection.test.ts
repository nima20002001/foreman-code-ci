import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MainCodexSelection, selectInstalledCodex } from '../src/modules/computers/installedCodexSelection.js'
import { ComputerMaintenance, systemMaintenancePorts } from '../src/modules/computers/maintenance.js'
import { readInstalledWorkflowConfiguration } from '../src/modules/runs/remote/installedWorkflowConfiguration.js'
import { NativeCodexPlugins } from '../src/modules/harnesses/codexPlugins.js'
import { CodexMcpConnections } from '../src/modules/harnesses/codexMcpConnections.js'

const qualify = vi.hoisted(() => vi.fn<(binary: string) => Promise<never>>()
  .mockRejectedValue(new Error('Qualification required')))
vi.mock('../src/modules/harnesses/codexProtocol.js', () => ({
  qualifyCodex: qualify, assertCodexUnchanged: vi.fn(),
}))

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture(selected: Record<string, unknown> | null, installedVersion: string | null = 'codex-cli 0.162.0') {
  const home = await mkdtemp(join(tmpdir(), 'codex-selection-'))
  homes.push(home)
  const state = join(home, 'state')
  await mkdir(state, { mode: 0o700 })
  const path = join(state, 'workflow-runtime.json')
  if (selected) { await writeFile(path, JSON.stringify(selected), { mode: 0o600 }) }
  let binary: string | null = null
  if (installedVersion) {
    const bin = join(home, '.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin')
    await mkdir(bin, { recursive: true })
    binary = join(bin, 'codex')
    await writeFile(binary, `#!/bin/sh\necho '${installedVersion}'\n`)
    await chmod(binary, 0o755)
  }
  return { home, state, location: { path, ownerUid: process.getuid!() }, binary }
}

const pinned = { schemaVersion: 1, codexBinary: '/opt/pinned/codex', expectedVersion: 'codex-cli 0.154.0', payloadPaths: [],
  appMcpLauncher: '/opt/app/mcp/launcher.mjs' }

describe('installed Codex selection after a maintenance update', () => {
  it('updates Main from its configured binary and retains the shared selection after restart', async () => {
    const f = await fixture(null, 'codex-cli 0.161.0')
    const configured = join(f.home, 'configured-codex')
    await writeFile(configured, '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 })
    const statePath = join(f.state, 'main-codex.json')
    const filesystem = systemMaintenancePorts({ HOME: f.home })
    const selection = new MainCodexSelection(configured, statePath, filesystem)
    await selection.initialize()
    const consumers = { get codex() { return selection.binary } }
    const plugins = new NativeCodexPlugins(() => selection.binary, f.home)
    const mcp = new CodexMcpConnections(() => selection.binary, f.home)
    const checkConsumers = async (binary: string) => {
      qualify.mockClear()
      await expect(plugins.list(AbortSignal.timeout(10_000))).rejects.toThrow('Qualification required')
      await expect(mcp.read(AbortSignal.timeout(10_000))).rejects.toThrow('Qualification required')
      expect(qualify.mock.calls.map(call => call[0])).toEqual([binary, binary])
    }
    await checkConsumers(configured)
    const ports = systemMaintenancePorts({ HOME: f.home }, consumers)
    const nativeRun = ports.run
    ports.run = async (binary, args, options) => {
      if (args[0] === 'view') return { code: 0, stdout: '0.161.0', stderr: '' }
      if (args[0] === 'install') return { code: 0, stdout: 'installed', stderr: '' }
      return nativeRun(binary, args, options)
    }
    ports.find = async name => {
      if (name === 'codex') return consumers.codex
      if (name === 'npm') return '/fixture/npm'
      return null
    }
    ports.selectInstalledCodex = signal => selection.selectInstalled(signal)
    const owner = new ComputerMaintenance(ports)
    await owner.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    await expect.poll(async () => (await owner.status(AbortSignal.timeout(10_000))).tasks[0]?.state).toBe('succeeded')
    expect(selection.binary).toBe(f.binary)
    expect(await ports.find('codex')).toBe(f.binary)
    await checkConsumers(f.binary!)
    const restored = new MainCodexSelection(configured, statePath, filesystem)
    await restored.initialize()
    expect(restored.binary).toBe(f.binary)
    const changedConfiguration = new MainCodexSelection('/opt/different/codex', statePath, filesystem)
    await changedConfiguration.initialize()
    expect(changedConfiguration.binary).toBe('/opt/different/codex')
  })

  it('selects the freshly installed native Codex and keeps the selection private and readable', async () => {
    const f = await fixture(pinned)
    expect(await selectInstalledCodex(f.location, f.home, AbortSignal.timeout(10_000))).toBe(f.binary)
    expect(await readInstalledWorkflowConfiguration(f.location)).toEqual({ ...pinned, codexBinary: f.binary,
      expectedVersion: 'codex-cli 0.162.0', payloadPaths: [] })
    expect((await stat(f.location.path)).mode & 0o777).toBe(0o600)
    expect((await readdir(f.state)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('leaves a Worker without a Codex selection on the maintained Codex in PATH', async () => {
    const f = await fixture({ schemaVersion: 1, appMcpLauncher: '/opt/app/mcp/launcher.mjs',
      claude: { binary: '/opt/claude', installedLockPath: '/opt/claude.lock' } })
    expect(await selectInstalledCodex(f.location, f.home, AbortSignal.timeout(10_000))).toBeNull()
    expect((await readInstalledWorkflowConfiguration(f.location))?.codexBinary).toBeUndefined()
  })

  it('keeps the old selection when the update cannot be located or did not report a version', async () => {
    const missing = await fixture(pinned, null)
    await expect(selectInstalledCodex(missing.location, missing.home, AbortSignal.timeout(10_000)))
      .rejects.toThrow('could not be located')
    expect(await readInstalledWorkflowConfiguration(missing.location)).toEqual(pinned)
    const silent = await fixture(pinned, 'not a version')
    await expect(selectInstalledCodex(silent.location, silent.home, AbortSignal.timeout(10_000)))
      .rejects.toThrow('did not report its version')
    expect(await readInstalledWorkflowConfiguration(silent.location)).toEqual(pinned)
  })
})
