import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DeviceExecutionAdmissionFields } from '@foreman-code/contracts/device-resources'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JobRuntimeNativeAdmissionRecordSchema, JobVerificationQualificationCandidateSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { bootIdentity } from '../../src/modules/harnesses/recovery/linuxIdentity.js'
import { nativeAgentEnvironment } from '../../src/modules/harnesses/secrets.js'
import { fingerprintQualificationPath, jobQualificationFingerprint } from '../../src/modules/jobs/qualification.js'
import { reserveInstalledJobQualification } from '../../src/modules/jobs/installedRuntimeQualification.js'
import { createVerificationProfile } from '../../src/modules/jobs/verificationProfiles.js'
import { RemoteOperationJournal } from '../../src/modules/runs/remote/operationJournal.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { verificationRuntimeFixture } from './verificationRuntimeFixture.js'

export const hungQualificationDiagnostic = `
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const descendant = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));"
    + "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
  spawn(process.execPath, ['-e', descendant, process.argv[1] + '.descendant'],
    { detached: true, stdio: 'ignore' }).unref();
  fs.writeFileSync(process.argv[1], String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
`

/** Exercises installed ownership without running the full qualification suite or granting readiness. */
export async function jobQualificationFaultFixture(executable = process.execPath,
  environment?: Record<string, string>) {
  const directory = await privateFixtureDirectory('job-qualification-fault-')
  const runtimeRoot = join(directory, 'runtime')
  const sourceParent = join(directory, 'sources')
  await mkdir(runtimeRoot, { mode: 0o700 })
  await mkdir(sourceParent, { mode: 0o700 })
  const baseline = verificationRuntimeFixture()
  const fingerprint = baseline.measurement.fingerprint
  const qualificationId = randomUUID()
  const approvalId = randomUUID()
  const now = new Date().toISOString()
  const root = { ...fingerprint.root, binding: { ...fingerprint.root.binding, canonicalPath: sourceParent } }
  const profile = createVerificationProfile({
    id: fingerprint.profileId, workspaceId: root.binding.workspaceId, revision: 1,
    name: 'Qualification interruption', root, sourceCommit: fingerprint.sourceCommit!,
    spec: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision,
      resources: fingerprint.resources, policy: jobPolicyRequirementsRecord(baseline.spec.policy),
      suites: ['unit'], approvalConfig: { approvalLifetimeMs: 24 * 60 * 60 * 1000 } },
    previous: null, now,
  })
  const candidate = JobVerificationQualificationCandidateSchema.parse({
    qualificationId, operationId: qualificationId, approvalId, profile, approvedAt: now,
    fingerprint: { ...fingerprint, root, bootId: bootIdentity(), specDigest: profile.specDigest,
      runtimeExecutable: executable, runtimeBinarySha256: (await fingerprintQualificationPath(executable, true)).sha256,
      approvalConfig: profile.approvalConfig },
    backingFile: null, backingBytes: null, volumeCapacityBytes: fingerprint.quota.volumeCapacityBytes,
    findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: 'a'.repeat(64),
    controllerEnvironment: nativeAgentEnvironment(executable, runtimeRoot, environment ?? {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`,
      LANG: 'C.UTF-8',
    }),
    sourceParent, runtimeRoot, spoolBytes: 131072, ttlSeconds: 600,
  })
  const admission = JobRuntimeNativeAdmissionRecordSchema.parse({
    schemaVersion: 3, kind: 'job-runtime-qualification', approvalId, qualificationId,
    operationId: qualificationId, workspaceId: root.binding.workspaceId,
    profileId: profile.id, profileRevision: profile.revision,
    fingerprintDigest: jobQualificationFingerprint(candidate), leaseId: randomUUID(),
    runCommandId: randomUUID(), runPrincipalId: 'qualification-owner', approvedByPrincipalId: 'qualification-owner',
    hostRef: fingerprint.hostRef, registration: null, mainInstallationId: fingerprint.mainInstallationId,
    bootId: candidate.fingerprint.bootId, connection: null, admittedAt: now,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...Object.fromEntries(Object.keys(DeviceExecutionAdmissionFields)
      .map(key => [key, Reflect.get(candidate.fingerprint, key)])),
  })
  const journalPath = join(directory, 'journal.json')
  const journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
  const registryPath = join(runtimeRoot, 'native-process-registry')
  const registry = new NativeProcessRegistry(registryPath)
  const owner = `qualification:${admission.operationId}:${admission.leaseId}`
  const authority = {
    assertCurrent: async () => {},
    readApproval: async () => ({ status: 'approved' as const,
      fingerprint: admission.fingerprintDigest, expiresAt: admission.expiresAt }),
    reserve: async () => { throw new Error('Use the installed reservation.') },
  }
  const host = { hostRef: admission.hostRef, registration: admission.registration,
    mainInstallationId: admission.mainInstallationId, bootId: admission.bootId, connection: admission.connection }
  const lifetime = new AbortController()
  const input = { candidate, admission, host, journal, registry, authority,
    assertAdmission: async () => {}, signal: lifetime.signal }
  const reserved = await reserveInstalledJobQualification(input)
  const fixture = { directory, runtimeRoot, sourceParent, journalPath, registryPath, owner,
    lifetime, input, reserved,
    async claimQuota() {
      const slot = candidate.fingerprint.quotaPool!.slots[0]!
      const path = join(sourceParent, `quota-${slot.namespace}.claim.json`)
      const namespace = join(sourceParent, slot.namespace, admission.operationId)
      await mkdir(namespace, { recursive: true, mode: 0o700 })
      await writeFile(join(namespace, 'partial-output'), 'unfinished', { mode: 0o600 })
      await writeFile(path, JSON.stringify({ kind: 'qualification', qualificationId,
        operationId: admission.operationId }), { mode: 0o600, flag: 'wx' })
      const metadata = await stat(path)
      await reserved.native.recordQuotaClaim!({ path, namespace, device: metadata.dev, inode: metadata.ino })
      return { path, namespace }
    },
    async reopen() {
      await input.journal.close()
      input.journal = await RemoteOperationJournal.open(journalPath)
      input.registry = new NativeProcessRegistry(registryPath)
    },
    async close() {
      lifetime.abort(new Error('Fixture shutdown'))
      if (input.registry.snapshot().launches.length && !await input.registry.closeOwner(owner)) {
        throw new Error('Qualification fixture process closure remains unconfirmed.')
      }
      await input.journal.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
  return fixture
}
