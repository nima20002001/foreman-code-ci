import { createHash } from 'node:crypto'
import { chmod, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { InstalledVerificationRuntimeConfigurationSchema } from './installedVerificationConfiguration.js'
import { readInstalledVerificationConfiguration } from './installedVerificationRuntime.js'
import { installedSourceQuotaPool } from './quotaOwnership.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function projectConfiguration() {
  const profile = verificationCapacityFixture('device')
  const fingerprint = profile.measurement!.fingerprint
  const omitted = new Set(['schemaVersion', 'profileId', 'profileRevision', 'specDigest', 'root', 'hostRef',
    'registration', 'mainInstallationId'])
  const machine = Object.fromEntries(Object.entries(fingerprint).filter(([key]) => !omitted.has(key)))
  const manifest = { version: 1, ...profile.root.source, git: { commit: profile.sourceCommit,
    tree: 'a'.repeat(40), objectFormat: 'sha1' }, capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved',
    entries: [], deletions: [], totalEntries: 0, totalBytes: 0 }
  const configuration = InstalledVerificationRuntimeConfigurationSchema.parse({ schemaVersion: 2, root: profile.root,
    machine, seedReceiptPath: '/ci/project-seed.json', seedReceiptSha256: fingerprint.seedReceiptSha256,
    qualificationSource: { directory: '/ci/project-source', manifest },
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
  return { profile, configuration }
}

async function fixture() {
  const directory = await privateFixtureDirectory('retained-project-runtime-')
  roots.push(directory)
  const original = projectConfiguration()
  const other = structuredClone(original.configuration)
  other.root.binding.workspaceId = 'second-project'
  other.root.binding.canonicalPath = '/ci/second-project'
  other.machine.imageDigest = `sha256:${'b'.repeat(64)}`
  const originalBytes = JSON.stringify(original.configuration)
  const digest = createHash('sha256').update(originalBytes).digest('hex')
  const archive = join(directory, `job-runtime-${digest}.json`)
  const location = { path: join(directory, 'job-runtime.json'), ownerUid: process.getuid!() }
  await writeFile(archive, originalBytes, { mode: 0o600 })
  await writeFile(location.path, JSON.stringify(other), { mode: 0o600 })
  return { ...original, directory, location, archive, other }
}

describe('retained project verification runtimes', () => {
  it('reads the first project runtime and quota pool after another project becomes current', async () => {
    const f = await fixture()
    const selected = await readInstalledVerificationConfiguration(f.location, f.profile)
    expect(selected).toEqual(f.configuration)
    expect(selected.machine.imageDigest).not.toBe(f.other.machine.imageDigest)
    expect(await installedSourceQuotaPool(f.location, f.profile.root.binding)).toEqual(f.configuration.descriptor.quotaPool)
    expect(JSON.parse(await readFile(f.location.path, 'utf8'))).toEqual(f.other)
  })

  it('does not substitute another project for a missing protected runtime', async () => {
    const f = await fixture()
    await rm(f.archive)
    await expect(readInstalledVerificationConfiguration(f.location, f.profile))
      .rejects.toMatchObject({ code: 'JOB_RUNTIME_CONTEXT_CHANGED' })
    expect(await installedSourceQuotaPool(f.location, f.profile.root.binding)).toBeNull()
  })

  it.each(['image', 'source', 'resources', 'root'] as const)('rejects a changed profile %s', async field => {
    const f = await fixture()
    const profile = structuredClone(f.profile)
    if (field === 'image') profile.spec.policy.imageDigest = `sha256:${'c'.repeat(64)}`
    if (field === 'source') profile.sourceCommit = 'c'.repeat(40)
    if (field === 'resources') profile.spec.resources.limits.cpuLimit++
    if (field === 'root') profile.root.binding.canonicalPath = '/ci/unapproved-root'
    await expect(readInstalledVerificationConfiguration(f.location, profile))
      .rejects.toMatchObject({ code: 'JOB_RUNTIME_CONTEXT_CHANGED' })
  })

  it('rejects a retained configuration whose recorded bytes changed', async () => {
    const f = await fixture()
    await writeFile(f.archive, JSON.stringify({ ...f.configuration, seedReceiptPath: '/ci/changed-seed.json' }))
    await expect(readInstalledVerificationConfiguration(f.location, f.profile))
      .rejects.toMatchObject({ code: 'JOB_RUNTIME_CONTEXT_CHANGED' })
  })

  it.each(['symlink', 'writable'] as const)('keeps protected-file checks for a retained %s', async kind => {
    const f = await fixture()
    if (kind === 'symlink') {
      const original = join(f.directory, 'redirected.json')
      await writeFile(original, await readFile(f.archive), { mode: 0o600 })
      await rm(f.archive)
      await symlink(original, f.archive)
    } else await chmod(f.archive, 0o666)
    await expect(readInstalledVerificationConfiguration(f.location, f.profile))
      .rejects.toMatchObject({ code: 'JOB_RUNTIME_INSTALLATION_UNAVAILABLE' })
  })
})
