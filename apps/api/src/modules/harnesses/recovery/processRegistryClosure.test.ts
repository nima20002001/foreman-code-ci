import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { privateFixtureDirectory } from '../../../../test/helpers/privateFixtureDirectory.js'
import { NativeProcessRegistry } from './processRegistry.js'
import { bootIdentity, processIdentity } from './linuxIdentity.js'
import { privateDirectory, writeRecord } from './storage.js'

const kernel = vi.hoisted(() => ({ populated: false, killed: vi.fn(), retired: vi.fn() }))
vi.mock('./cgroupBoundary.js', async original => ({
  ...await original<typeof import('./cgroupBoundary.js')>(),
  cgroupPopulated: () => kernel.populated,
  killCgroup: kernel.killed,
  retireCgroup: kernel.retired,
}))
afterEach(() => { vi.restoreAllMocks(); kernel.populated = false; kernel.killed.mockClear() })

async function fixture() {
  const directory = await privateFixtureDirectory('native-closure-')
  const root = join(directory, 'registry')
  const registry = new NativeProcessRegistry(root)
  await registry.ready()
  const owner = 'execution:stopped-execution'
  const scope = await registry.reserveLaunch(owner)
  const ownerDirectory = join(root, createHash('sha256').update(owner).digest('hex'))
  const registration = join(ownerDirectory, scope.launchId!)
  const current = processIdentity(process.pid)!
  // The numeric PID is live, but the recorded generation no longer exists.
  const gone = { ...current, startTicks: '0', group: current.pid, session: current.pid }
  writeRecord(join(registration, 'birth.json'), {
    format: 1, id: scope.launchId, owner, boot: bootIdentity(), guardian: gone,
  })
  writeRecord(join(registration, 'provider.json'), {
    format: 1, id: scope.launchId, owner, boot: bootIdentity(), guardian: gone,
    capture: 'captured', provider: gone,
  })
  return { directory, root, registry, owner, scope, ownerDirectory, registration, gone, current }
}

it('keeps a surviving recorded provider fenced after its guardian disappears', async () => {
  const f = await fixture()
  try {
    writeRecord(join(f.registration, 'provider.json'), {
      format: 1, id: f.scope.launchId, owner: f.owner, boot: bootIdentity(), guardian: f.gone,
      capture: 'captured', provider: f.current,
    })
    await expect(f.registry.closeOwner(f.owner, AbortSignal.timeout(100))).rejects.toThrow()
    expect(f.registry.closedRegistration(f.owner, f.scope.launchId!)).toBeUndefined()
    expect(kernel.killed).not.toHaveBeenCalled()
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

it.each(['boot-changed', 'empty-cgroup'] as const)('confirms %s closure without a PID-only kill', async kind => {
  const f = await fixture()
  const kill = vi.spyOn(process, 'kill')
  try {
    if (kind === 'boot-changed') {
      writeRecord(join(f.registration, 'intent.json'), {
        format: 1, id: f.scope.launchId, owner: f.owner, boot: randomUUID(),
        parent: f.current, controlKey: 'a'.repeat(64),
      })
      // These certificates belong to the same recorded boot.
      rmSync(join(f.registration, 'birth.json'))
      rmSync(join(f.registration, 'provider.json'))
    } else {
      writeRecord(join(f.registration, 'birth.json'), {
        format: 1, id: f.scope.launchId, owner: f.owner, boot: bootIdentity(), guardian: f.gone,
        containment: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/graphql-native-${f.scope.launchId}`,
          device: '1', inode: '1' },
      })
    }
    expect(await f.registry.closeOwner(f.owner, AbortSignal.timeout(200))).toBe(true)
    expect(kill).not.toHaveBeenCalled()
    expect(kernel.killed).not.toHaveBeenCalled()
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

it('prunes aged closed owner directories while preserving original closure readback and retries', async () => {
  const directory = await privateFixtureDirectory('native-retirement-')
  const root = privateDirectory(join(directory, 'registry'))
  const observations = Array.from({ length: 12 }, () => ({
    owner: `execution:${randomUUID()}`, launchId: randomUUID(), bootId: bootIdentity(),
    lifecycle: 'closed' as const, closureEvidence: 'native_not_started' as const,
  }))
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  try {
    for (const observation of observations) {
      const ownerDirectory = privateDirectory(join(root, createHash('sha256').update(observation.owner).digest('hex')))
      const closed = join(ownerDirectory, `closed-${observation.launchId}.json`)
      const retired = join(ownerDirectory, 'retired.json')
      writeRecord(closed, observation)
      writeRecord(retired, { format: 2, owner: observation.owner, id: observation.launchId, observation })
      utimesSync(closed, old, old)
      utimesSync(retired, old, old)
    }
    // Maintenance is budgeted per construction, so a backlog is archived over several constructions.
    let registry = new NativeProcessRegistry(root)
    await registry.ready()
    for (let attempt = 0; attempt < 20 && readdirSync(root).some(name => /^[0-9a-f]{64}$/.test(name)); attempt++) {
      registry = new NativeProcessRegistry(root)
      await registry.ready()
    }
    expect(readdirSync(root).filter(name => /^[0-9a-f]{64}$/.test(name))).toHaveLength(0)
    for (const observation of observations) {
      expect(registry.closedRegistration(observation.owner, observation.launchId)).toEqual(observation)
      expect(await registry.closeOwner(observation.owner)).toBe(true)
      await registry.closeRegistration(registry.scope(observation.owner), observation.launchId)
    }
    expect(registry.snapshot().launches).toEqual([])
    expect(await registry.closeOwner('unknown-owner')).toBe(false)
    expect(existsSync(root)).toBe(true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('starts with an aged retirement receipt that has no observation and keeps that owner', async () => {
  const directory = await privateFixtureDirectory('native-retirement-legacy-')
  const root = privateDirectory(join(directory, 'registry'))
  const owner = `qualification:${randomUUID()}`
  const ownerDirectory = privateDirectory(join(root, createHash('sha256').update(owner).digest('hex')))
  const retired = join(ownerDirectory, 'retired.json')
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  try {
    writeRecord(retired, { format: 2, owner, id: randomUUID() })
    utimesSync(retired, old, old)
    expect(() => new NativeProcessRegistry(root)).not.toThrow()
    expect(existsSync(retired)).toBe(true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('archives a large retirement backlog a little per registry construction', async () => {
  const directory = await privateFixtureDirectory('native-retirement-budget-')
  const root = privateDirectory(join(directory, 'registry'))
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  const owners = () => readdirSync(root).filter(name => /^[0-9a-f]{64}$/.test(name)).length
  try {
    for (let index = 0; index < 6; index++) {
      const observation = { owner: `execution:${randomUUID()}`, launchId: randomUUID(), bootId: bootIdentity(),
        lifecycle: 'closed' as const, closureEvidence: 'native_not_started' as const }
      const ownerDirectory = privateDirectory(join(root, createHash('sha256').update(observation.owner).digest('hex')))
      const retired = join(ownerDirectory, 'retired.json')
      writeRecord(retired, { format: 2, owner: observation.owner, id: observation.launchId, observation })
      utimesSync(retired, old, old)
    }
    // Each owner appears to take 60 ms, so one construction archives only part of the backlog.
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 30))
    await new NativeProcessRegistry(root).ready()
    const remaining = owners()
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThan(6)
    for (let attempt = 0; attempt < 6 && owners(); attempt++) await new NativeProcessRegistry(root).ready()
    expect(owners()).toBe(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('archives owners that age after an earlier maintenance sweep finished', async () => {
  const directory = await privateFixtureDirectory('native-retirement-continuous-')
  const root = privateDirectory(join(directory, 'registry'))
  const observation = { owner: `execution:${randomUUID()}`, launchId: randomUUID(), bootId: bootIdentity(),
    lifecycle: 'closed' as const, closureEvidence: 'native_not_started' as const }
  const ownerDirectory = privateDirectory(join(root, createHash('sha256').update(observation.owner).digest('hex')))
  const retired = join(ownerDirectory, 'retired.json')
  try {
    writeRecord(retired, { format: 2, owner: observation.owner, id: observation.launchId, observation })
    await new NativeProcessRegistry(root).ready()
    expect(existsSync(ownerDirectory)).toBe(true)
    // The receipt passes its retention window while this process keeps running.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(retired, old, old)
    const later = Date.now() + 2 * 60 * 60 * 1000
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    const registry = new NativeProcessRegistry(root)
    await registry.ready()
    expect(existsSync(ownerDirectory)).toBe(false)
    expect(await registry.closeOwner(observation.owner)).toBe(true)
    expect(registry.closedRegistration(observation.owner, observation.launchId)).toEqual(observation)
    expect(registry.snapshot().launches).toEqual([])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
