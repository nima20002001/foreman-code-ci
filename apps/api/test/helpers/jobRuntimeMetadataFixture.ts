import { randomUUID } from 'node:crypto'
import { JOB_RUNTIME_WORKSPACE_LAYOUT, JobRuntimeFingerprintSchema, JobRuntimeMeasurementSchema,
  JobRuntimeProfileSchema, type JobRuntimeProfile } from '@foreman-code/contracts/job-runtime'
import { jobDigest } from '../../src/modules/jobs/service.js'

/** Retained qualification metadata for carrier-boundary tests; no physical runtime qualification claim. */
export function jobRuntimeMetadataFixture(original: JobRuntimeProfile, bootId: string) {
  const fingerprint = JobRuntimeFingerprintSchema.parse({ schemaVersion: 1, profileId: original.id,
    profileRevision: original.revision, specDigest: original.specDigest, hostRef: original.root.selection.hostRef,
    registration: original.root.registration, mainInstallationId: original.root.binding.mainId, bootId,
    root: original.root, runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: '1'.repeat(64),
    ociExecutable: '/usr/bin/crun', ociBinarySha256: '2'.repeat(64), configurationDigest: '3'.repeat(64),
    imageDigest: original.policy.imageDigest, toolchainDigest: original.policy.toolchainDigest,
    limits: original.limits, workspaceLayout: JOB_RUNTIME_WORKSPACE_LAYOUT })
  const qualificationId = randomUUID()
  const measurement = JobRuntimeMeasurementSchema.parse({ schemaVersion: 1, qualificationId,
    profileId: original.id, profileRevision: original.revision, specDigest: original.specDigest,
    hostRef: fingerprint.hostRef, registration: fingerprint.registration, root: original.root,
    runtime: { ...original.limits, policyId: original.id, policyRevision: original.revision,
      imageDigest: fingerprint.imageDigest, toolchainDigest: fingerprint.toolchainDigest,
      runtimeVersion: 'fixture', ociRuntimeVersion: 'fixture', kernelVersion: 'fixture', qualificationId,
      rootless: true, cgroupV2: true, filesystemBounded: true, descendantContainment: true, network: 'none',
      workspaceLayout: JOB_RUNTIME_WORKSPACE_LAYOUT },
    runtimeBinarySha256: fingerprint.runtimeBinarySha256, ociBinarySha256: fingerprint.ociBinarySha256,
    runtimeExecutable: fingerprint.runtimeExecutable,
    environment: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/runtime', LANG: 'C.UTF-8' },
    fingerprint, fingerprintDigest: jobDigest(fingerprint), approvalId: randomUUID(), origin: 'real-runtime',
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    checks: ['rootless', 'cgroup-v2', 'filesystem-quota', 'descendant-containment', 'network-none',
      'image-toolchain', 'credential-isolation'].map(id => ({ id, passed: true, evidenceDigest: '4'.repeat(64) })),
  })
  const profile = JobRuntimeProfileSchema.parse({ ...original, status: 'qualified', measurement })
  const descriptor = { target: { hostRef: fingerprint.hostRef, registration: fingerprint.registration,
    mainInstallationId: fingerprint.mainInstallationId }, runtimeExecutable: fingerprint.runtimeExecutable,
    ociExecutable: fingerprint.ociExecutable, findmntExecutable: '/usr/bin/findmnt', findmntBinarySha256: '5'.repeat(64),
    runtimeRoot: '/runtime', backingFile: '/runtime/backing',
    controllerEnvironment: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/runtime', LANG: 'C.UTF-8' as const } }
  return { profile, fingerprint, descriptor }
}
