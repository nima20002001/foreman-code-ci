import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readCiInstalledStorage } from './ciInstalledStorage.js'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { InstalledVerificationRuntimeConfigurationSchema } from './installedVerificationConfiguration.js'
import { DEVICE_RESOURCE_CONTROL_RESERVE } from '@foreman-code/contracts/device-resources'

function configuration() {
  const profile = verificationCapacityFixture('device')
  const fingerprint = profile.measurement!.fingerprint
  const omitted = new Set(['schemaVersion', 'profileId', 'profileRevision', 'specDigest', 'root', 'hostRef',
    'registration', 'mainInstallationId'])
  const machine = Object.fromEntries(Object.entries(fingerprint).filter(([key]) => !omitted.has(key)))
  const manifest = { version: 1, ...profile.root.source, git: { commit: profile.sourceCommit,
    tree: 'a'.repeat(40), objectFormat: 'sha1' }, capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved',
    entries: [], deletions: [], totalEntries: 0, totalBytes: 0 }
  return InstalledVerificationRuntimeConfigurationSchema.parse({ schemaVersion: 2, root: profile.root,
    machine, seedReceiptPath: '/ci/seed.json', seedReceiptSha256: fingerprint.seedReceiptSha256,
    qualificationSource: { directory: '/ci/source', manifest },
    descriptor: { target: { hostRef: fingerprint.hostRef, registration: fingerprint.registration,
      mainInstallationId: fingerprint.mainInstallationId }, runtimeExecutable: fingerprint.runtimeExecutable,
      ociExecutable: fingerprint.ociExecutable, findmntExecutable: '/usr/bin/findmnt', findmntBinarySha256: 'f'.repeat(64),
      runtimeRoot: '/ci/runtime', backingFile: null, volumeCapacityBytes: fingerprint.quota.volumeCapacityBytes,
      controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
      quota: fingerprint.quota, quotaPool: fingerprint.quotaPool, resources: fingerprint.resources,
      network: fingerprint.network, approvalConfig: fingerprint.approvalConfig,
      resourcePolicyRevision: fingerprint.resourcePolicyRevision, resourcePolicyDigest: fingerprint.resourcePolicyDigest,
      runtimeApprovalId: fingerprint.runtimeApprovalId, runtimeApprovalRevision: fingerprint.runtimeApprovalRevision,
      aggregateCgroupIdentityDigest: fingerprint.aggregateCgroupIdentityDigest } })
}

it('reports no installed storage before configuration without accepting an unprotected file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ci-installed-storage-'))
  try {
    expect(await readCiInstalledStorage(directory)).toBeNull()
    const configuration = join(directory, 'job-runtime.json')
    await writeFile(configuration, '{}', { mode: 0o600 })
    await chmod(configuration, 0o666)
    await expect(readCiInstalledStorage(directory)).rejects.toMatchObject({
      code: 'JOB_RUNTIME_INSTALLATION_UNAVAILABLE',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('sizes enrollment to an installed quota slot and the computer storage allowance without returning readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ci-installed-storage-'))
  try {
    const installed = configuration()
    const slot = installed.descriptor.quotaPool!.slots[0]!
    installed.machine.deviceLimits!.diskBytes = DEVICE_RESOURCE_CONTROL_RESERVE.diskBytes + slot.hardLimitBytes / 2
    await writeFile(join(directory, 'job-runtime.json'), JSON.stringify(installed), { mode: 0o600 })
    expect(await readCiInstalledStorage(directory)).toEqual({
      diskBytes: slot.hardLimitBytes / 2, mutableInodes: slot.hardInodes,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects a symlink in place of the protected runtime configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ci-installed-storage-'))
  try {
    const original = join(directory, 'original.json')
    await writeFile(original, JSON.stringify(configuration()), { mode: 0o600 })
    await symlink(original, join(directory, 'job-runtime.json'))
    await expect(readCiInstalledStorage(directory)).rejects.toMatchObject({
      code: 'JOB_RUNTIME_INSTALLATION_UNAVAILABLE',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('reads adopted storage while requiring a fresh executable runtime capture for the new pairing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ci-adopted-storage-'))
  try {
    const runtime = configuration()
    const target = { ...runtime.descriptor.target,
      hostRef: { kind: 'device', mainId: '22222222-2222-4222-8222-222222222222',
        deviceId: '33333333-3333-4333-8333-333333333333' },
      mainInstallationId: '22222222-2222-4222-8222-222222222222' }
    await writeFile(join(directory, 'ci-runtime-installation.json'), JSON.stringify({ schemaVersion: 1, target, runtime }),
      { mode: 0o600 })
    const slot = runtime.descriptor.quotaPool!.slots[0]!
    expect(await readCiInstalledStorage(directory)).toEqual({ diskBytes: slot.hardLimitBytes, mutableInodes: slot.hardInodes })
    await expect(import('./installedRuntimeHost.js').then(module => module.readInstalledRuntimeConfiguration({
      path: join(directory, 'job-runtime.json'), ownerUid: process.getuid!(),
    }))).rejects.toMatchObject({ code: 'JOB_RUNTIME_INSTALLATION_UNAVAILABLE' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
