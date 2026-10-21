import { createHash } from 'node:crypto'
import { rm,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { JobVerificationOfflineSeedReceiptSchema,JobVerificationProfileSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { InstalledVerificationRuntimeConfigurationSchema } from './installedVerificationConfiguration.js'
import { createInstalledJobRuntimeHost } from './installedRuntimeHost.js'
import type { JobSql } from './repository.js'
import { verificationProfileReadiness } from './runtimeProfiles.js'
import { jobDigest } from './service.js'
import * as qualification from './qualification.js'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path,{ recursive:true,force:true })))
})

async function fixture() {
  const directory = await privateFixtureDirectory('verification-inspection-')
  directories.push(directory)
  const base = verificationCapacityFixture('main')
  const digest = 'a'.repeat(64)
  const now = new Date().toISOString()
  const seed = JobVerificationOfflineSeedReceiptSchema.parse({
    schemaVersion:1,packageManager:'pnpm@11.27.0',platform:{ os:'linux',arch:'x64',libc:'glibc' },
    minimumReleaseAge:2880,minimumReleaseAgeStrict:true,minimumReleaseAgeIgnoreMissingTime:false,
    capturedAt:now,provenanceDigest:digest,review:{ reviewedByPrincipalId:'owner',reviewedAt:now,decisionDigest:digest },
    maxBytes:1024,maxInodes:10,packages:[],
    dependencyInputs:['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'].map(path => ({ path,sha256:digest })),
    files:['corepack-cache/pnpm.json','pnpm-store/index.db','registry-cache/fixture.json']
      .map(path => ({ path,bytes:1,sha256:digest })),
  })
  const seedBytes = Buffer.from(JSON.stringify(seed))
  const seedReceiptPath = join(directory,'seed.json')
  await writeFile(seedReceiptPath,seedBytes,{ mode:0o600 })
  const installedConfiguration = { configuration:'original' }
  const configurationDigest = createHash('sha256').update(canonicalGraphJson(installedConfiguration)).digest('hex')
  const fingerprint = { ...base.measurement!.fingerprint,bootId:bootIdentity(),configurationDigest,
    seedReceiptSha256:createHash('sha256').update(seedBytes).digest('hex') }
  const profile = JobVerificationProfileSchema.parse({ ...base,measurement:{ ...base.measurement,fingerprint,
    identity:{ ...base.measurement!.identity,fingerprintDigest:jobDigest(fingerprint) } } })
  const omitted = new Set(['schemaVersion','profileId','profileRevision','specDigest','root','hostRef',
    'registration','mainInstallationId'])
  const machine = Object.fromEntries(Object.entries(fingerprint).filter(([key]) => !omitted.has(key)))
  const configuration = InstalledVerificationRuntimeConfigurationSchema.parse({ schemaVersion:2,root:profile.root,machine,
    seedReceiptPath,seedReceiptSha256:fingerprint.seedReceiptSha256,
    qualificationSource:{ directory:'/ci/source',manifest:{ version:1,...profile.root.source,
      git:{ commit:profile.sourceCommit,tree:'a'.repeat(40),objectFormat:'sha1' },capturePolicy:'git-tree-v1',
      executablePolicy:'preserve-approved',entries:[],deletions:[],totalEntries:0,totalBytes:0 } },
    descriptor:{ target:{ hostRef:fingerprint.hostRef,registration:null,mainInstallationId:fingerprint.mainInstallationId },
      runtimeExecutable:fingerprint.runtimeExecutable,ociExecutable:fingerprint.ociExecutable,
      findmntExecutable:'/usr/bin/findmnt',findmntBinarySha256:digest,runtimeRoot:'/ci/runtime',backingFile:null,
      volumeCapacityBytes:fingerprint.quota.volumeCapacityBytes,quota:fingerprint.quota,quotaPool:fingerprint.quotaPool,
      resources:fingerprint.resources,network:fingerprint.network,approvalConfig:fingerprint.approvalConfig,
      resourcePolicyRevision:fingerprint.resourcePolicyRevision,resourcePolicyDigest:fingerprint.resourcePolicyDigest,
      runtimeApprovalId:fingerprint.runtimeApprovalId,runtimeApprovalRevision:fingerprint.runtimeApprovalRevision,
      aggregateCgroupIdentityDigest:fingerprint.aggregateCgroupIdentityDigest,
      controllerEnvironment:{ PATH:'/usr/bin:/bin',XDG_RUNTIME_DIR:'/run/user/1000',LANG:'C.UTF-8' } },
  })
  const configurationPath = join(directory,'job-runtime.json')
  await writeFile(configurationPath,JSON.stringify(configuration),{ mode:0o600 })
  let binaryDigest = digest
  vi.spyOn(qualification,'fingerprintQualificationPath').mockImplementation(async path => ({
    path,device:profile.root.binding.filesystem.device,inode:profile.root.binding.filesystem.inode,
    mode:'493',uid:'1000',gid:'1000',sha256:path === '/usr/bin/findmnt' ? binaryDigest : digest,
  }))
  vi.spyOn(qualification,'qualificationMountId').mockReturnValue(profile.root.binding.filesystem.mountId)
  const capture = vi.spyOn(qualification,'captureJobRuntimeConfiguration').mockResolvedValue(
    installedConfiguration as unknown as Awaited<ReturnType<typeof qualification.captureJobRuntimeConfiguration>>)
  const sql = { query:async () => ({ rows:[{ id:fingerprint.mainInstallationId }] }) } as unknown as JobSql
  const reserve = vi.fn(async () => { throw new Error('Inspection attempted native work') })
  const host = createInstalledJobRuntimeHost({ identity:sql,configuration:{ path:configurationPath,ownerUid:process.getuid!() },
    reserve })
  return { profile,fingerprint,sql,host,reserve,capture,
    changeBinary() { binaryDigest = 'b'.repeat(64) } }
}

it.each(['configuration','diagnostic-binary'] as const)('invalidates fresh verification metadata after a %s change', async change => {
  const f = await fixture()
  const saved = structuredClone(f.profile)
  expect(await f.host.capture!(f.profile)).toEqual(f.fingerprint)
  if (change === 'configuration') f.capture.mockResolvedValue(
    { configuration:'changed' } as unknown as Awaited<ReturnType<typeof qualification.captureJobRuntimeConfiguration>>)
  else f.changeBinary()
  await expect(f.host.capture!(f.profile)).rejects.toMatchObject({ code:'JOB_RUNTIME_CONTEXT_CHANGED' })
  const current = await f.host.currentMetadata(f.sql,f.profile)
  expect(current).toBeNull()
  expect(verificationProfileReadiness({ profile:f.profile,currentFingerprint:null })).toMatchObject({ ready:false })
  expect(f.profile).toEqual(saved)
  expect(f.reserve).not.toHaveBeenCalled()
})
