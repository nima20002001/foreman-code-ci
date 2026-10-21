import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { installedSourceQuotaPool, readVerificationQuotaPool, verifyJobQuotaOwnership,
  isKernelQuotaDenial, type JobQuotaReader } from './quotaOwnership.js'
import { constants } from 'node:os'

const profile = verificationCapacityFixture('main')
const pool = profile.measurement!.fingerprint.quotaPool!
const slot = pool.slots[0]!
const observed = { volumeCapacityBytes: 64 * 2 ** 30, volumeCapacityInodes: pool.volumeCapacityInodes,
  projectId: slot.projectId, inheritance: true as const, hardLimitBytes: slot.hardLimitBytes,
  hardInodes: slot.hardInodes, usedBytes: 4096, usedInodes: 1,
  accountingEnabled: true as const, filesystem: slot.filesystem }
function verify(read: JobQuotaReader) {
  return verifyJobQuotaOwnership({ pool, binding: profile.root.binding, slot,
    signal: new AbortController().signal, read })
}
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function installedQuota() {
  const directory = await mkdtemp('/tmp/source-cleanup-quota-')
  directories.push(directory)
  const path = join(directory, 'runtime.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 2, root: profile.root, descriptor: { quotaPool: pool } }),
    { mode: 0o600 })
  return { path, ownerUid: process.getuid!() }
}

describe('installed source quota selection', () => {
  it('uses the same pool after its source binding changed on the installed physical root', async () => {
    const configuration = await installedQuota()
    const binding = { ...profile.root.binding, bindingRevision: profile.root.binding.bindingRevision + 1,
      snapshotId: '22222222-2222-4222-8222-222222222222', manifestDigest: '2'.repeat(64) }
    expect(await installedSourceQuotaPool(configuration, binding)).toEqual(pool)
  })

  it.each(['mainId', 'deviceId', 'workerInstallationId', 'rootId', 'workspaceId', 'canonicalPath',
    'locationRevision', 'filesystem', 'accessMode'] as const)(
    'refuses a changed physical root field: %s', async field => {
      const configuration = await installedQuota()
      const changed = { mainId: '22222222-2222-4222-8222-222222222222',
        deviceId: '22222222-2222-4222-8222-222222222222',
        workerInstallationId: '22222222-2222-4222-8222-222222222222',
        rootId: '22222222-2222-4222-8222-222222222222', workspaceId: 'another-workspace',
        canonicalPath: '/another/root', locationRevision: profile.root.binding.locationRevision + 1,
        filesystem: { ...profile.root.binding.filesystem, inode: '9999' }, accessMode: 'read-only' as const }
      expect(await installedSourceQuotaPool(configuration, { ...profile.root.binding, [field]: changed[field] }))
        .toBeNull()
    })
})
describe('observed project quota ownership', () => {
  it('recognizes the kernel quota errno without accepting unrelated unknown or disk-full errors', () => {
    expect(isKernelQuotaDenial(-constants.errno.EDQUOT!)).toBe(true)
    for (const errno of [undefined, null, 'UNKNOWN', -constants.errno.ENOSPC!, 0]) {
      expect(isKernelQuotaDenial(errno)).toBe(false)
    }
  })
  it('reads every slot without overlapping commands on the diagnostic owner', async () => {
    let active = 0
    let maximum = 0
    const read: JobQuotaReader = async (_pool, directory) => {
      active++
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active--
      const selected = pool.slots.find(value => directory === join(profile.root.binding.canonicalPath, value.namespace))!
      return { ...observed, projectId: selected.projectId, hardLimitBytes: selected.hardLimitBytes,
        hardInodes: selected.hardInodes, filesystem: selected.filesystem }
    }
    const results = await readVerificationQuotaPool(pool, profile.root.binding, new AbortController().signal, read)
    expect(results.map(value => value.projectId)).toEqual(pool.slots.map(value => value.projectId))
    expect(maximum).toBe(1)
  })
  it('accepts kernel readback matching the selected independent quota', async () => {
    expect(await verify(async () => observed)).toEqual(observed)
  })
  it.each([
    { projectId: slot.projectId + 1 }, { hardLimitBytes: slot.hardLimitBytes * 2 },
    { hardInodes: slot.hardInodes * 2 }, { usedBytes: slot.hardLimitBytes + 1 },
    { usedInodes: slot.hardInodes + 1 }, { volumeCapacityInodes: pool.volumeCapacityInodes + 1 },
    { filesystem: { ...slot.filesystem, inode: '9999' } },
  ])('rejects changed kernel identity, limits, geometry or usage: %j', async changed => {
    await expect(verify(async () => ({ ...observed, ...changed })))
      .rejects.toMatchObject({ code: 'JOB_QUOTA_CHANGED' })
  })
  it('propagates missing kernel quota access rather than treating declarations as readback', async () => {
    await expect(verify(async () => { throw new Error('quotactl denied') })).rejects.toThrow('quotactl denied')
  })
})
