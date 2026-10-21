import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { FleetMaintenanceService } from '../src/modules/computers/fleet.js'
import { ComputerMaintenance, type MaintenancePorts } from '../src/modules/computers/maintenance.js'
import { deferred } from './helpers/deferred.js'

vi.mock('../src/modules/access/liveManagementPrincipal.js', () => ({
  readLiveManagementPrincipal: async () => principal,
}))
const principal: ManagementPrincipal = {
  id: randomUUID(), name: 'Maintainer', audience: 'operator', revokedAt: null,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }],
}

function computer() {
  const versions = { codex: '0.160.0', claude: '2.1.19' }
  const files = new Map<string, string>()
  const runs: { binary: string; args: string[] }[] = []
  let installGate: Promise<void> | undefined
  const ports: MaintenancePorts = {
    environment: { HOME: '/fixture/owner' },
    find: async name => ['codex', 'claude', 'npm'].includes(name) ? `/fixture/${name}` : null,
    run: async (binary, args) => {
      runs.push({ binary, args })
      let stdout = ''
      if (args[0] === '--version') stdout = binary.endsWith('claude') ? versions.claude : `codex-cli ${versions.codex}`
      if (args[0] === 'view') stdout = args[1] === '@openai/codex' ? '0.161.0' : '2.1.294'
      if (args[0] === 'install') {
        await installGate
        versions.codex = '0.161.0'
      }
      if (args[0] === 'update') versions.claude = '2.1.294'
      return { code: 0, stdout, stderr: '' }
    },
    exists: async () => false,
    readText: async path => files.get(path) ?? null,
    writePrivateText: async (path, text) => { files.set(path, text) },
    disk: async () => null,
    later: () => {},
    now: () => new Date(),
  }
  return { ports, versions, runs, holdInstall: (gate: Promise<void>) => { installGate = gate } }
}

const signal = () => AbortSignal.timeout(10_000)
async function settled(owner: ComputerMaintenance) {
  await expect.poll(async () => (await owner.status(signal())).tasks.some(task => task.state === 'running')).toBe(false)
  return owner.status(signal())
}

describe('maintenance task lifecycle', () => {
  it('closes admission and drains an accepted update with its original persisted task', async () => {
    const fake = computer()
    const install = deferred<void>()
    fake.holdInstall(install.promise)
    const owner = new ComputerMaintenance(fake.ports)
    const commandId = randomUUID()
    const accepted = await owner.start({ kind: 'update-harnesses', harnesses: ['codex'] }, commandId)
    await expect.poll(() => fake.runs.some(run => run.args[0] === 'install')).toBe(true)
    owner.stopAdmission()
    let drained = false
    const closing = owner.drain().then(() => { drained = true })
    await expect(owner.start({ kind: 'update-harnesses', harnesses: ['claude'] }))
      .rejects.toMatchObject({ code: 'COMPUTER_MAINTENANCE_CLOSING' })
    expect(drained).toBe(false)
    install.resolve()
    await closing
    const restarted = new ComputerMaintenance(fake.ports)
    const readback = await restarted.status(signal())
    expect(readback.tasks.find(task => task.id === accepted.id)).toMatchObject({ id: commandId, state: 'succeeded' })
    expect(fake.runs.filter(run => run.args[0] === 'install')).toHaveLength(1)
    expect(fake.runs.some(run => run.args[0] === 'update')).toBe(false)
  })

  it('does not admit host work when an upkeep status read finishes after shutdown starts', async () => {
    const fake = computer()
    const observation = deferred<null>()
    let reading = false
    fake.ports.disk = () => { reading = true; return observation.promise }
    const local = new ComputerMaintenance(fake.ports)
    const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) }
    const fleet = new FleetMaintenanceService(pool as never, randomUUID(), () => undefined, {} as never, local, {
      codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
      codexPlugins: async () => [], codexMarketplaces: async () => [],
      claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
    })
    const upkeep = fleet.keepCurrent()
    await expect.poll(() => reading).toBe(true)
    fleet.stopAdmission()
    let drained = false
    const drain = fleet.drain().then(() => { drained = true })
    expect(drained).toBe(false)
    observation.resolve(null)
    await Promise.all([upkeep, drain])
    await fleet.keepCurrent()
    await fleet.syncChangedSources()
    expect(fake.runs.some(run => ['install', 'update'].includes(run.args[0]!))).toBe(false)
    expect((await local.status(signal())).tasks).toEqual([])
  })
  it('rejects duplicate harness selectors before admitting native work', async () => {
    const fake = computer()
    const owner = new ComputerMaintenance(fake.ports)
    await expect(owner.start({ kind: 'update-harnesses', harnesses: ['codex', 'codex'] }))
      .rejects.toThrow('Choose each harness once.')
    expect(fake.runs).toEqual([])
    expect((await owner.status(signal())).tasks).toEqual([])
  })

  it.each(['codex', 'claude'] as const)('accepts a newer stable %s release installed after discovery', async harness => {
    const fake = computer()
    const run = fake.ports.run
    fake.ports.run = async (binary, args, options) => {
      const result = await run(binary, args, options)
      if (args[0] === 'install') fake.versions.codex = '0.162.0'
      if (args[0] === 'update') fake.versions.claude = '2.1.295'
      return result
    }
    const owner = new ComputerMaintenance(fake.ports)
    await owner.start({ kind: 'update-harnesses', harnesses: [harness] })
    await owner.drain()
    const restarted = new ComputerMaintenance(fake.ports)
    expect((await restarted.status(signal())).tasks[0]).toMatchObject({
      state: 'succeeded', summary: expect.stringContaining(fake.versions[harness]),
    })
  })

  it('still fails when the installed release is older or a prerelease of the stable target', async () => {
    for (const installed of ['0.160.1', '0.161.0-preview.1']) {
      const fake = computer()
      const run = fake.ports.run
      fake.ports.run = async (binary, args, options) => {
        const result = await run(binary, args, options)
        if (args[0] === 'install') fake.versions.codex = installed
        return result
      }
      const owner = new ComputerMaintenance(fake.ports)
      await owner.start({ kind: 'update-harnesses', harnesses: ['codex'] })
      await owner.drain()
      expect((await owner.status(signal())).tasks[0]).toMatchObject({ state: 'failed' })
    }
  })

  it('queues a broader harness update and shares only equivalent requests', async () => {
    const fake = computer()
    const install = deferred<void>()
    fake.holdInstall(install.promise)
    const owner = new ComputerMaintenance(fake.ports)
    const first = await owner.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    await expect.poll(() => fake.runs.some(run => run.args[0] === 'install')).toBe(true)
    const broader = await owner.start({ kind: 'update-harnesses', harnesses: ['codex', 'claude'] })
    const equivalent = await owner.start({ kind: 'update-harnesses', harnesses: ['claude', 'codex'] })
    install.resolve()
    const status = await settled(owner)
    expect(broader.id).not.toBe(first.id)
    expect(equivalent.id).toBe(broader.id)
    expect(status.tasks).toHaveLength(2)
    expect(status.tasks.every(task => task.state === 'succeeded')).toBe(true)
    expect(status.harnesses.find(entry => entry.harness === 'claude')?.version).toBe('2.1.294')
    expect(fake.runs.filter(run => run.args[0] === 'update')).toHaveLength(1)
  })

  it('resamples versions when an update finishes during a slow status probe', async () => {
    const fake = computer()
    const install = deferred<void>()
    fake.holdInstall(install.promise)
    const owner = new ComputerMaintenance(fake.ports)
    await owner.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    await expect.poll(() => fake.runs.some(run => run.args[0] === 'install')).toBe(true)
    const disk = deferred<null>()
    fake.ports.disk = () => disk.promise
    const reading = owner.status(signal())
    await expect.poll(() => fake.runs.filter(run => run.args[0] === '--version').length).toBe(3)
    install.resolve()
    fake.ports.disk = async () => null
    await settled(owner)
    disk.resolve(null)
    const snapshot = await reading
    expect(snapshot.tasks[0]).toMatchObject({ state: 'succeeded', summary: 'Codex 0.160.0 → 0.161.0' })
    expect(snapshot.harnesses[0]?.version).toBe('0.161.0')
  })

  it('resamples package and reboot facts when an OS update finishes during a status probe', async () => {
    const fake = computer()
    const upgrade = deferred<void>()
    let upgraded = false
    let packageReads = 0
    const find = fake.ports.find
    const run = fake.ports.run
    fake.ports.find = name => name === 'apt-get' ? Promise.resolve('/fixture/apt-get') : find(name)
    fake.ports.exists = async path => path === '/var/run/reboot-required' && upgraded
    fake.ports.run = async (binary, args, options) => {
      if (binary.endsWith('apt-get')) {
        packageReads++
        return { code: 0, stdout: `${upgraded ? 0 : 2} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.`, stderr: '' }
      }
      if (args.includes('upgrade')) {
        await upgrade.promise
        upgraded = true
        return { code: 0, stdout: '2 upgraded', stderr: '' }
      }
      return run(binary, args, options)
    }
    const owner = new ComputerMaintenance(fake.ports)
    await owner.start({ kind: 'update-system' })
    const disk = deferred<null>()
    fake.ports.disk = () => disk.promise
    const reading = owner.status(signal())
    await expect.poll(() => packageReads).toBe(1)
    upgrade.resolve()
    fake.ports.disk = async () => null
    await settled(owner)
    disk.resolve(null)
    const snapshot = await reading
    expect(snapshot.tasks[0]?.state).toBe('succeeded')
    expect(snapshot.system).toMatchObject({ packageUpdates: 0, rebootRequired: true })
  })

  it('saves task identity before acknowledgement or native work and surfaces failed writes', async () => {
    const fake = computer()
    const save = deferred<void>()
    const write = fake.ports.writePrivateText
    let saving = false
    fake.ports.writePrivateText = async (path, text) => {
      saving = true
      await save.promise
      await write(path, text)
    }
    const owner = new ComputerMaintenance(fake.ports)
    let acknowledged = false
    const starting = owner.start({ kind: 'update-harnesses', harnesses: ['codex'] })
      .then(task => { acknowledged = true; return task })
    await expect.poll(() => saving).toBe(true)
    expect(acknowledged).toBe(false)
    expect(fake.runs.some(run => run.args[0] === 'install')).toBe(false)
    save.resolve()
    await starting
    await settled(owner)

    const unavailable = computer()
    unavailable.ports.writePrivateText = async () => { throw new Error('Task storage is unavailable') }
    const failed = new ComputerMaintenance(unavailable.ports)
    await expect(failed.start({ kind: 'update-harnesses', harnesses: ['codex'] })).rejects.toThrow('Task storage is unavailable')
    await expect(failed.status(signal())).rejects.toThrow('Task storage is unavailable')
    expect(unavailable.runs).toEqual([])
  })

  it('retains completed tasks and marks unfinished tasks interrupted after restart', async () => {
    const fake = computer()
    const owner = new ComputerMaintenance(fake.ports)
    const completed = await owner.start({ kind: 'update-harnesses', harnesses: ['claude'] })
    await settled(owner)
    const install = deferred<void>()
    fake.holdInstall(install.promise)
    const unfinished = await owner.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    await expect.poll(() => fake.runs.some(run => run.args[0] === 'install')).toBe(true)
    const restarted = new ComputerMaintenance(fake.ports)
    const snapshot = await restarted.status(signal())
    expect(snapshot.tasks.find(task => task.id === completed.id)).toMatchObject({ state: 'succeeded' })
    expect(snapshot.tasks.find(task => task.id === unfinished.id)).toMatchObject({
      state: 'failed', summary: expect.stringContaining('interrupted'), finishedAt: expect.any(String),
    })
    expect((await new ComputerMaintenance(fake.ports).status(signal())).tasks).toEqual(snapshot.tasks)
    install.resolve()
    await settled(owner)
  })

  it('replays the retained interrupted task rather than the original running acknowledgement', async () => {
    const fake = computer()
    const install = deferred<void>()
    fake.holdInstall(install.promise)
    const owner = new ComputerMaintenance(fake.ports)
    const task = await owner.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    await expect.poll(() => fake.runs.some(run => run.args[0] === 'install')).toBe(true)
    const mainId = randomUUID()
    const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null }
    const saved = { computers: [{ target, task, error: null }] }
    const commands = {
      execute: async () => ({ value: saved, replayed: true }),
      recordDenied: vi.fn(),
    }
    const sql = { query: async () => ({ rows: [] }), release: () => {} }
    const service = new FleetMaintenanceService({ connect: async () => sql } as never, mainId, () => undefined,
      commands as never, new ComputerMaintenance(fake.ports), {
        codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
        codexPlugins: async () => [], codexMarketplaces: async () => [],
        claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
      })
    const input = { commandId: randomUUID(), task: { kind: 'update-harnesses' as const, harnesses: ['codex' as const] },
      targets: [target] }
    const replay = await service.start(principal, 'mcp', input)
    expect(replay.computers[0]?.task).toMatchObject({ id: task.id, state: 'failed',
      summary: expect.stringContaining('interrupted') })
    expect(task.state).toBe('running')
    expect(fake.runs.filter(run => run.args[0] === 'install')).toHaveLength(1)
    await expect(service.start({ ...principal, grants: [{ actions: ['settings:read'], scope: {} }] }, 'mcp', input))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(commands.recordDenied).toHaveBeenCalledOnce()
    install.resolve()
    await settled(owner)
  })
})
