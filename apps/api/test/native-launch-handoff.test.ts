import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeProcessRegistry, spawnNativeProcess } from '../src/modules/harnesses/recovery/processRegistry.js'
import { bootIdentity, processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { privateDirectory, readRecord, writeRecord } from '../src/modules/harnesses/recovery/storage.js'
import { reserveFromExitedParent } from './helpers/eng06LaunchReservation.testSupport.js'

/** Real filesystem, fsync, parent PID/start-time and kernel liveness checks.
 * These no-dispatch cuts intentionally need no native binary or cgroup mount. */
describe.skipIf(process.platform !== 'linux')('write-ahead native launch handoff', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'native-launch-handoff-')); roots.push(root)
    const owner = `execution:${randomUUID()}`
    const directory = join(root, createHash('sha256').update(owner).digest('hex'))
    return { root, owner, directory, registry: new NativeProcessRegistry(root) }
  }

  it('does not turn missing or empty inventory into closure evidence', async () => {
    const t = fixture()
    expect(await t.registry.closeOwner(t.owner)).toBe(false)
    privateDirectory(t.directory)
    expect(await t.registry.closeOwner(t.owner)).toBe(false)
    expect(readRecord(join(t.directory, 'retired.json'))).toBeUndefined()
  })

  it.each([false, true])('recovers a dead parent before dispatch (claimed=%s), once only', async (claimed) => {
    const t = fixture(), scope = reserveFromExitedParent(t.root, t.owner)
    const launch = join(t.directory, scope.launchId!)
    expect(readRecord(join(launch, 'intent.json'))).toMatchObject({ id: scope.launchId, owner: t.owner, format: 1 })
    if (claimed) writeRecord(join(launch, 'claimed.json'), { format: 1, id: scope.launchId, owner: t.owner }, true)
    expect(readRecord(join(launch, 'dispatched.json'))).toBeUndefined()
    expect(readRecord(join(launch, 'birth.json'))).toBeUndefined()
    expect(await t.registry.closeOwner(t.owner)).toBe(true)
    const retired = readRecord(join(t.directory, 'retired.json'))
    expect(retired).toEqual({ format: 2, owner: t.owner, id: scope.launchId, observation: {
      owner: t.owner, launchId: scope.launchId, bootId: bootIdentity(), lifecycle: 'closed', closureEvidence: 'native_not_started',
    } })
    expect(await new NativeProcessRegistry(t.root).closeOwner(t.owner)).toBe(true)
    expect(readRecord(join(t.directory, 'retired.json'))).toEqual(retired)
    expect(readdirSync(t.directory)).toEqual([`closed-${scope.launchId}.json`, 'retired.json'])
  })

  it('cannot close a still-live parent reservation or allocate over it', async () => {
    const t = fixture(), scope = await t.registry.reserveLaunch(t.owner)
    await expect(t.registry.closeOwner(t.owner, AbortSignal.timeout(75))).rejects.toBeInstanceOf(AggregateError)
    await expect(t.registry.reserveLaunch(t.owner)).rejects.toThrow()
    expect(readRecord(join(t.directory, scope.launchId!, 'intent.json'))).toBeDefined()
    expect(readRecord(join(t.directory, 'retired.json'))).toBeUndefined()
  })

  it.each(['dead-parent', 'wrong-owner', 'wrong-id', 'retired'] as const)(
    'a %s handoff cannot dispatch or silently reserve a replacement', async (caseName) => {
      const t = fixture(), original = reserveFromExitedParent(t.root, t.owner)
      if (caseName === 'retired') expect(await t.registry.closeOwner(t.owner)).toBe(true)
      const scope = { ...original,
        ...(caseName === 'wrong-owner' ? { owner: `execution:${randomUUID()}` } : {}),
        ...(caseName === 'wrong-id' ? { launchId: randomUUID() } : {}) }
      const inventory = readdirSync(t.directory)
      expect(() => spawnNativeProcess(process.execPath, ['-e', 'throw new Error("MUST NOT DISPATCH")'],
        { cwd: t.root, env: {}, recovery: scope })).toThrow()
      expect(readdirSync(t.directory)).toEqual(inventory)
    })

  it('a dispatched live guardian is uncertainty, not a no-submission receipt', async () => {
    const t = fixture(), scope = reserveFromExitedParent(t.root, t.owner)
    const guardian = processIdentity(process.pid)
    expect(guardian).toBeDefined()
    // Fault input at the registry protocol boundary: no birth certificate and
    // an exact LIVE guardian identity. The registry must not signal that PID.
    writeRecord(join(t.directory, scope.launchId!, 'dispatched.json'), { id: scope.launchId, guardian }, true)
    await expect(t.registry.closeOwner(t.owner, AbortSignal.timeout(75))).rejects.toBeInstanceOf(AggregateError)
    expect(readRecord(join(t.directory, 'retired.json'))).toBeUndefined()
    expect(processIdentity(process.pid)).toEqual(guardian)
  })
})
