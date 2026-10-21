import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { inflateSync } from 'node:zlib'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { JOB_PRIVATE_GIT_LAYOUT, JOB_GIT_ENVIRONMENT, type VerifiedJobGitMounts } from './privateGitMounts.js'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type { JobRuntimeProfile } from '@foreman-code/contracts/job-runtime'
import { CI_QUALIFICATION_SUITE, JobQualificationCandidateSchema, fingerprintQualificationPath, jobQualificationFingerprint,
  validateBoundedVolumeGeometry, qualificationMountId, qualifyJobRuntime, validateIsolationMeasurement, verifyJobQualification,
  validateJobQualificationMounts, prepareQualificationPrivateGit, createPhysicalJobRuntimeProducer, type JobQualificationCandidate, type JobQualificationRecord } from './qualification.js'
import { backingFileConfigurationIdentity } from './qualification.js'
import { runQualificationCommand, type QualificationNativeOwner } from './qualification.js'
import { validateVerificationIsolationObservation } from './qualification.js'
import { ensureEmptyPodmanHooks, podmanIsolationCreateArgv, type PodmanIsolationInput } from './executorPodman.js'
import { requireVerificationRuntime } from './executor.js'
import { VerificationJobExecutionSchema } from '@foreman-code/contracts/job-verification'
import { verificationFixture } from '../../../test/helpers/jobVerificationFixture.js'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { verificationRepositoryContext } from './executorOutputs.js'

const id = '00000000-0000-4000-8000-000000000001'
const digest = 'a'.repeat(64)
const hash = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')

it('keeps sparse backing identity stable as writes allocate extents and detects replacement or resizing', () => {
  const backing = { path: '/approved/volume.ext4', device: '1', inode: '2', bytes: '68719476736',
    allocatedBytes: '1024', mode: '33056', uid: '0', links: '1' }
  const original = backingFileConfigurationIdentity(backing)
  expect(backingFileConfigurationIdentity({ ...backing, allocatedBytes: '68719620096' })).toEqual(original)
  expect(original.reservedBytes).toBe(backing.bytes)
  expect(backingFileConfigurationIdentity({ ...backing, inode: '3' })).not.toEqual(original)
  expect(backingFileConfigurationIdentity({ ...backing, bytes: '34359738368' })).not.toEqual(original)
})

it('retains bounded diagnostic stderr alongside the original native exit code', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const owner = { reserveProcess: async () => 'reserved-command',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stdout.write('observed output');
        child.stderr.write('fixture diagnostic failure');
        child.emit('close', 7, null);
      });
      return child as unknown as ChildProcess;
    },
    readNativeExit: async () => ({ confirmed: true, exitCode: 7 }),
  } as unknown as QualificationNativeOwner;
  expect(await runQualificationCommand(owner, '/approved/diagnostic', [], {}, new AbortController().signal))
    .toEqual({ exitCode: 7, stdout: 'observed output', stderr: 'fixture diagnostic failure' });
})

it('reports measured isolation values without copying arbitrary observation fields into errors', () => {
  const f = verificationRuntimeFixture()
  const input = { observation: { interfaces: [], privateToken: 'fixture-private-value' },
    resources: f.measurement.fingerprint.resources, hostPidNamespace: 'pid:[1]',
    hostNetworkNamespace: 'net:[1]', hostCgroupNamespace: 'cgroup:[1]', ownerSentinelPaths: ['/owner-sentinel'] }
  try {
    validateVerificationIsolationObservation(input)
    expect.fail('Invalid observation was accepted')
  } catch (error) {
    expect((error as Error).message).toContain('interfaces')
    expect((error as Error).message).not.toContain('fixture-private-value')
  }
})
function candidate(): JobQualificationCandidate {
  return JobQualificationCandidateSchema.parse({ qualificationId: id, operationId: id, approvalId: id,
    fingerprint: { workspaceLayout:JOB_PRIVATE_GIT_LAYOUT,schemaVersion: 1, profileId: id, profileRevision: 1, specDigest: digest,
      hostRef: { kind: 'main', mainId: id }, registration: null, mainInstallationId: id, bootId: id,
      runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest, ociExecutable: '/usr/bin/crun', ociBinarySha256: digest,
      imageDigest: `sha256:${digest}`, toolchainDigest: digest, configurationDigest: digest,
      limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 2097152 },
      root: { version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
        selection: { hostRef: { kind: 'main', mainId: id }, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1' },
        binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: id, rootId: id, bindingRevision: 1,
          locationRevision: 1, canonicalPath: '/approved/source', filesystem: { device: '12', inode: '34', mountId: '56' },
          accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest }, ownerPrincipalId: id, authorizedByPrincipalId: id,
        registration: null, attestationId: id, attestationDigest: digest, boundAt: '2026-10-01T00:00:00Z' } },
    backingFile: '/approved/ci-volume.ext4', backingBytes: 2097152,
    findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: digest, controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
    sourceParent: '/approved/source', runtimeRoot: '/approved/runtime', spoolBytes: 131072, ttlSeconds: 600 })
}


describe('offline verification launch validation with structured physical observations', () => {
  it('rejects another source commit before using the approved runtime', () => {
    const f = verificationRuntimeFixture()
    expect(() => requireVerificationRuntime({ ...f.spec,
      source: { ...f.spec.source, commit: 'c'.repeat(40) } }, f.measurement, f.runtime))
      .toThrow('no matching measured offline runtime')
  })
  it('caps worker entry at the reviewed ceiling even when measurements allow more', () => {
    const f = verificationRuntimeFixture()
    f.measurement.suites[0]!.maxUnitWorkers = 16
    const request = (unitWorkers: number) => ({ ...f.spec, verification: { ...f.spec.verification,
      parameters: { ...f.spec.verification.parameters, unitWorkers } } })
    expect(() => requireVerificationRuntime(request(12), f.measurement, f.runtime)).not.toThrow()
    expect(() => requireVerificationRuntime(request(16), f.measurement, f.runtime)).toThrow('matching measured')
  })
  it.each(['unit', 'integration'] as const)('derives the trusted %s wrapper context within qualified limits', suite => {
    const f = verificationRuntimeFixture()
    if (suite === 'integration') {
      f.spec.verification.suite = suite
      f.spec.verification.parameters.integrationShards = 2
      f.measurement.suites[0]!.suite = suite
      f.measurement.suites[0]!.maxIntegrationShards = 2
      f.measurement.fingerprint.tools.push({ kind: 'postgresql', executable: '/usr/lib/postgresql/17/bin/postgres',
        version: '17.6', binarySha256: digest })
      f.measurement.checks.push({ id: 'postgres-isolation', passed: true, evidenceDigest: digest })
    }
    const paths = [
      ['suite-summary', 'summary.json', 'application/json'], ['junit', 'junit.xml', 'application/xml'],
      ['vitest-json', 'vitest.json', 'application/json'], ['logs-archive', 'logs.tar.gz', 'application/gzip'],
    ]
    const execution = VerificationJobExecutionSchema.parse({ ...jobExecution(), schemaVersion: 2,
      acceptedSpec: { ...f.spec, outputs: paths.map(([kind, name, mediaType]) => ({ kind,
        path: `.logs/verification/${name}`, mediaType, required: true, maxBytes: 1024 })) } })
    const preseedFacts = { lockfileSha256: digest, pnpmVersion: '11.27.0', platform: 'linux', architecture: 'x64',
      provenanceDigest: digest, minimumReleaseAgeMinutes: 2880, releaseAgeVerified: true }
    const spec = execution.acceptedSpec
    const parent = dirname(spec.target.destination.canonicalProjectRoot)
    const filesystem = { device: '1', inode: '2', mountId: '3' }
    const gitMounts: VerifiedJobGitMounts = {
      version: 1, layout: JOB_PRIVATE_GIT_LAYOUT, workspaceId: execution.workspaceId,
      executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId,
      owner: execution.owner, specDigest: spec.specDigest, bindingHash: spec.bindingHash,
      materializationId: spec.source.materializationId, materializationDigest: spec.source.materializationDigest,
      git: { directory: join(parent, 'repository'), filesystem, generatedCommit: '4'.repeat(40),
        sourceCommit: spec.source.commit, repositoryReceiptDigest: digest, configDigest: digest,
        indexDigest: digest, mountpoint: filesystem },
      scheduler: { directory: join(parent, 'job-heavy-jobs'), filesystem }, receiptDigest: digest,
    }
    const context = verificationRepositoryContext({ execution, measurement: f.measurement, preseedFacts, gitMounts, requiredPortions: [{ key: 'root:install', kind: 'command' }] })
    expect(context.identity).toMatchObject({ executionId: execution.id, attemptId: execution.attemptId,
      commit: f.spec.source.commit, profile: f.spec.profile, resources: f.spec.verification.resources })
    expect(context.qualifiedUnitWorkers).toBe(1)
    expect(context.qualifiedIntegrationShards).toBe(suite === 'integration' ? 2 : 1)
    expect(() => verificationRepositoryContext({ execution: { ...execution,
      acceptedSpec: { ...execution.acceptedSpec, verification: { ...execution.acceptedSpec.verification,
        parameters: { ...execution.acceptedSpec.verification.parameters, integrationShards: 3 } } } },
      measurement: f.measurement, preseedFacts, gitMounts,
      requiredPortions: [{ key: 'root:install', kind: 'command' }] })).toThrow('qualification required')
    expect(context.storeDirectory).toBe('/job-scratch/pnpm-store')
    expect(context.privateGit).toMatchObject({ generatedCommit: '4'.repeat(40), sourceCommit: spec.source.commit })
    expect(context.limits).toEqual({ summaryBytes: 1024, junitBytes: 1024, vitestBytes: 1024,
      logsArchiveBytes: 1024, logBytes: 1024 })
    expect(() => verificationRepositoryContext({ execution, measurement: f.measurement, preseedFacts: null, gitMounts, requiredPortions: [{ key: 'root:install', kind: 'command' }] })).toThrow()
    expect(() => verificationRepositoryContext({ execution, measurement: f.measurement, preseedFacts,
      requiredPortions: [{ key: 'root:install', kind: 'command' }], gitMounts: { ...gitMounts, git: { ...gitMounts.git, sourceCommit: '0'.repeat(40) } } })).toThrow('Git/scheduler')
    expect(() => verificationRepositoryContext({ execution: { ...execution,
      acceptedSpec: { ...execution.acceptedSpec, outputs: execution.acceptedSpec.outputs.slice(0, 1) } },
      measurement: f.measurement, preseedFacts, gitMounts, requiredPortions: [{ key: 'root:install', kind: 'command' }] })).toThrow('every fixed')
  })
  it('denies host namespace, executable control temp, shared memory overflow and owner-home visibility', () => {
    const { resources } = verificationFixture()
    const ownerSentinelPaths = ['/owner/home/qualification-sentinel']
    const observation = { schemaVersion: 1, node: 'v22.23.3', pidNamespace: 'pid:[2]', networkNamespace: 'net:[2]',
      verificationEnvironment: 'isolated-job-v1', cgroupNamespace: 'cgroup:[2]', nativeCgroupDelegation: true,
      cgroupLimitWriteErrors: ['EACCES', 'EACCES', 'EACCES', 'EACCES'],
      interfaces: ['lo'], memoryMax: String(resources.limits.memoryBytes), swapMax: '0',
      pidsMax: String(resources.limits.pidsLimit), cpuRatio: resources.limits.cpuLimit,
      capabilities: '0000000000000000', noNewPrivileges: '1', controlExecution: 'EACCES', scratchExecution: 0,
      shmType: 0x01021994, controlTempType: 0x01021994, shmCapacityBytes: resources.shmBytes,
      controlTempCapacityBytes: resources.controlTempBytes,
      packagePolicy: { minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false },
      ownerSentinels: [{ path: ownerSentinelPaths[0], result: 'ENOENT' }],
      mountInfo: [
        '1 0 0:1 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw',
        '2 0 0:2 / /dev/shm rw,nosuid,nodev,noexec - tmpfs tmpfs rw',
        '3 0 0:3 / /job-scratch rw,nosuid,nodev - ext4 /dev/loop0 rw',
        '4 0 0:4 / /sys/fs/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw',
      ].join('\n') }
    const input = { observation, resources, ownerSentinelPaths, hostPidNamespace: 'pid:[1]', hostNetworkNamespace: 'net:[1]',
      hostCgroupNamespace: 'cgroup:[1]' }
    expect(() => validateVerificationIsolationObservation(input)).not.toThrow()
    for (const change of [{ verificationEnvironment: undefined }, { verificationEnvironment: 'unknown' },
      { cgroupNamespace: 'cgroup:[1]' }, { nativeCgroupDelegation: false },
      { cgroupLimitWriteErrors: [null, 'EACCES', 'EACCES', 'EACCES'] },
      { mountInfo: observation.mountInfo.replace('/sys/fs/cgroup rw,', '/sys/fs/cgroup ro,') },
      { mountInfo: observation.mountInfo + '\n5 0 0:5 / /host-cgroup rw - cgroup2 cgroup rw' },
      { pidNamespace: 'pid:[1]' }, { interfaces: ['lo', 'eth0'] }, { controlExecution: 0 },
      { shmCapacityBytes: resources.shmBytes + 1 }, { ownerSentinels: [{ path: ownerSentinelPaths[0], result: 'accessible' }] },
      { mountInfo: observation.mountInfo.replace('rw,nosuid,nodev - ext4', 'rw,nodev - ext4') }]) {
      expect(() => validateVerificationIsolationObservation({ ...input, observation: { ...observation, ...change } }))
        .toThrow('isolation rejected')
    }
  })
  it('runs another commit only with Main\'s dependency basis naming the computer\'s qualification commit', () => {
    const f = verificationRuntimeFixture(), qualified = f.measurement.fingerprint.sourceCommit!
    const inputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map(path => ({ path, sha256: '9'.repeat(64) }))
    const other = { ...f.spec, source: { ...f.spec.source, commit: '7'.repeat(40) } }
    expect(() => requireVerificationRuntime(other, f.measurement, f.runtime)).toThrow()
    expect(requireVerificationRuntime({ ...other, dependencyBasis: { qualificationCommit: qualified, inputs } }, f.measurement, f.runtime))
      .toEqual(f.measurement)
    expect(() => requireVerificationRuntime({ ...other, dependencyBasis: { qualificationCommit: '6'.repeat(40), inputs } },
      f.measurement, f.runtime)).toThrow()
  })
  it('requires separate measured suite evidence and enough reviewed validity without double-subtracting capacity', () => {
    const f = verificationRuntimeFixture()
    expect(requireVerificationRuntime(f.spec, f.measurement, f.runtime)).toEqual(f.measurement)
    expect(() => requireVerificationRuntime(f.spec, f.measurement, f.runtime,
      Date.parse(f.measurement.expiresAt) - 1)).toThrow()
    const unbounded = structuredClone(f.measurement)
    unbounded.fingerprint.quota.workloadHardInodes++
    unbounded.identity.fingerprintDigest = hash(unbounded.fingerprint)
    expect(() => requireVerificationRuntime({ ...f.spec, profile: unbounded.identity }, unbounded, f.runtime))
      .toThrow('unenforced')
    expect(() => requireVerificationRuntime({ ...f.spec, verification: {
      ...f.spec.verification, parameters: { unitWorkers: 2, integrationShards: 1 },
    } }, f.measurement, f.runtime)).toThrow('matching measured')
  })
  it('emits private bounded scratch, control temp and shm with no owner-home or network mount', () => {
    const { resources } = verificationFixture()
    const sourceRoot = `/approved/source/${id}/tree`
    const input = { identity: 'graphql-verification-test', sourceRoot, runtimeRoot: '/approved/runtime', cwd: sourceRoot,
      argv: ['corepack', 'pnpm', 'test'], profile: { ...resources.limits, imageDigest: `sha256:${digest}` },
      spoolBytes: 4096, labels: {}, inputRoot: `${sourceRoot}/.graphql-job-inputs`,
      gitDirectory: join(sourceRoot, '..', 'repository'), schedulerDirectory: join(sourceRoot, '..', 'job-heavy-jobs'),
      verification: { resources, scratchDirectory: join(sourceRoot, '..', 'job-scratch'),
        parameters: { unitWorkers: 1, integrationShards: 1 }, qualifiedIntegrationShards: 1 } }
    const argv = podmanIsolationCreateArgv(input)
    expect(argv).toContain('--network=none')
    expect(argv).toContain('--ipc=private')
    expect(argv).toContain('--cgroupns=private')
    expect(argv).toContain('--systemd=always')
    expect(argv).toContain('--cap-drop=ALL')
    expect(argv).toContain('--security-opt=no-new-privileges')
    const ordinary: PodmanIsolationInput = { ...input }
    delete ordinary.verification
    expect(podmanIsolationCreateArgv(ordinary)).not.toContain('--systemd=always')
    expect(argv).toContain(`/tmp:rw,nosuid,nodev,noexec,size=${resources.controlTempBytes}`)
    expect(argv.slice(argv.indexOf('--shm-size'), argv.indexOf('--shm-size') + 2)).toEqual(['--shm-size', String(resources.shmBytes)])
    expect(argv).toContain(`/dev/shm:rw,nosuid,nodev,noexec,size=${resources.shmBytes}`)
    expect(argv).toContain('--read-only')
    expect(argv).toContain('--read-only-tmpfs=false')
    expect(argv).toContain(`${input.verification.scratchDirectory}:/job-scratch:rw,nosuid,nodev,exec,rprivate`)
    expect(argv).toContain('HOME=/job-scratch/home')
    expect(argv).toContain('FOREMAN_CODE_VERIFICATION_ENVIRONMENT=isolated-job-v1')
    expect(argv).toContain('FOREMAN_CODE_VERIFICATION_UNIT_WORKERS=1')
    expect(argv).toContain('FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS=1')
    expect(() => podmanIsolationCreateArgv({ ...input, verification: { resources, scratchDirectory: '/owner/home' } }))
      .toThrow('reserved private boundary')
    expect(() => podmanIsolationCreateArgv({ ...input, profile: { ...input.profile, memoryBytes: 1 } }))
      .toThrow('reserved private boundary')
  })
})

describe('qualification metadata and measured observation verification (no native execution)', () => {
  it('denied, revoked, missing or expired approval performs zero admission/probes', async () => {
    for (const status of ['denied', 'revoked', 'expired', 'missing'] as const) {
      const request = candidate()
      const authority = { readApproval: vi.fn(async () => status === 'missing' ? null : {
        status: status === 'expired' ? 'approved' as const : status,
        fingerprint: jobQualificationFingerprint(request), expiresAt: status === 'expired' ? '2020-01-01T00:00:00Z' : '2100-01-01T00:00:00Z' }),
        assertCurrent: vi.fn(), reserve: vi.fn() }
      const record = await qualifyJobRuntime(request, authority, new AbortController().signal)
      expect(record).toMatchObject({ outcome: 'denied', closure: 'not_started', profile: null })
      expect(authority.reserve).not.toHaveBeenCalled()
      expect(authority.assertCurrent).not.toHaveBeenCalled()
    }
  })
  it('current stored deny supersedes ready history and verifier never probes', () => {
    const request = candidate()
    const record: JobQualificationRecord = { suite: CI_QUALIFICATION_SUITE, candidate: request, fingerprint: jobQualificationFingerprint(request),
      measuredFingerprint: null, outcome: 'denied', closure: 'confirmed', reasons: ['filesystem_quota_unavailable'], checkedAt: '2026-10-01T00:00:00Z', expiresAt: '2100-01-01T00:00:00Z', measurements: null, profile: null }
    expect(verifyJobQualification(null, request).reason).toBe('missing')
    expect(verifyJobQualification(record, request).reason).toBe('denied')
  })
  it('expires or invalidates any changed immutable context before considering evidence', () => {
    const request = candidate()
    const record = { suite: CI_QUALIFICATION_SUITE, candidate: request, fingerprint: jobQualificationFingerprint(request), outcome: 'qualified',
      closure: 'confirmed', checkedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-01T00:10:00Z', profile: null, measurements: null, measuredFingerprint: null, reasons: [] } satisfies JobQualificationRecord
    expect(verifyJobQualification(record, request, Date.parse('2026-10-01T00:11:00Z')).reason).toBe('expired')
    for (const change of ['boot', 'root', 'runtime', 'limits', 'configuration', 'policy'] as const) {
      const changed = structuredClone(request)
      if (change === 'boot') changed.fingerprint.bootId = '00000000-0000-4000-8000-000000000002'
      if (change === 'root') changed.fingerprint.root.binding.filesystem.inode = '35'
      if (change === 'runtime') changed.fingerprint.runtimeBinarySha256 = 'b'.repeat(64)
      if (change === 'limits') changed.fingerprint.limits.pidsLimit++
      if (change === 'configuration') changed.fingerprint.configurationDigest = 'b'.repeat(64)
      if (change === 'policy') changed.fingerprint.profileRevision++
      expect(verifyJobQualification(record, changed, Date.parse('2026-10-01T00:01:00Z')).reason).toBe('context_changed')
    }
    expect(verifyJobQualification(record, request, Date.parse('2026-10-01T00:01:00Z')).reason).toBe('evidence_invalid')
  })
  it('rejects injected controller credentials rather than passing them to a diagnostic', () => {
    expect(() => JobQualificationCandidateSchema.parse({ ...candidate(), controllerEnvironment: { ...candidate().controllerEnvironment, OPENAI_API_KEY: 'forbidden' } })).toThrow()
  })
  it('requires protected backing storage and finite ext4 geometry independently of physical allocation', () => {
    const observed = { expectedBytes: 2097152n, backingBytes: 2097152n, rootOwned: true, writableByWorker: false,
      links: 1n, offset: 0n, sizeLimit: 2097152n, blockDeviceBytes: 2097152n, filesystemBytes: 2000000n, filesystemType: 0xef53n, mountOptions: ['rw', 'nosuid', 'nodev'] }
    expect(() => validateBoundedVolumeGeometry(observed)).not.toThrow()
    for (const weaker of [{ rootOwned: false }, { writableByWorker: true }, { links: 2n }, { offset: 4096n },
      { sizeLimit: 0n }, { backingBytes: 4194304n }, { blockDeviceBytes: 4194304n }, { filesystemBytes: 4194304n }, { filesystemType: 0x58465342n },
      { mountOptions: ['rw'] }, { mountOptions: ['rw', 'nosuid', 'nodev', 'discard'] }]) expect(() => validateBoundedVolumeGeometry({ ...observed, ...weaker })).toThrow()
  })
  it('binds escaped mount paths and rejects prefix lookalikes', () => {
    const mounts = '1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:2 / /approved rw - xfs disk rw\n3 2 0:3 / /approved/space\\040here rw - xfs disk rw\n'
    expect(qualificationMountId('/approved/space here/child', mounts)).toBe('3')
    expect(qualificationMountId('/approved-looking/child', mounts)).toBe('1')
  })
  it('rejects weaker namespace/network/cgroup/toolchain observations', () => {
    const request = candidate()
    const probe = { toolchain: { node: 'v26.5.1', pnpm: '11.27.0', corepack: '0.34.6', git: 'git version 2.45.0', flock: 'flock from util-linux 2.39.3' },
      rootfsWriteError: 'EROFS', sourceWrite: true, proc: true, pidNamespace: 'pid:[300]', networkNamespace: 'net:[301]', interfaces: ['lo'],
      memoryMax: '67108864', swapMax: '0', pidsMax: '64', cpuRatio: 1, detachedChild: true, environment: ['CI', 'FOREMAN_CODE_JOB_INPUT_MANIFEST', 'GRAPHQL_JOB_INPUT_MANIFEST', 'HOME', 'LANG', 'PATH',...Object.keys(JOB_GIT_ENVIRONMENT)].sort(),gitCommon:'/graphql-job-git',gitRead:true,gitConfigWriteError:'EROFS',gitIndexWriteError:'EROFS',gitHeadWriteError:'EROFS',gitObjectWriteError:'EROFS',schedulerWrite:true, inputRead: true, inputWriteError: 'EROFS', capabilities: '0000000000000000', noNewPrivileges: '1' }
    const host = { hostPidNamespace: 'pid:[100]', hostNetworkNamespace: 'net:[101]' }
    expect(() => validateIsolationMeasurement(probe, request, host)).not.toThrow()
    for (const weaker of [{ pidNamespace: undefined }, { pidNamespace: host.hostPidNamespace }, { networkNamespace: host.hostNetworkNamespace },
      { interfaces: ['eth0', 'lo'] }, { memoryMax: 'max' }, { swapMax: 'max' }, { pidsMax: 'max' }, { cpuRatio: 2 }, { detachedChild: false }, { environment: ['API_TOKEN'] },{gitRead:false},{gitConfigWriteError:null},{gitIndexWriteError:null},{gitHeadWriteError:null},{gitObjectWriteError:null},{schedulerWrite:false}]) {
      expect(() => validateIsolationMeasurement({ ...probe, ...weaker }, request, host)).toThrow()
    }
  })
  it('measures actual bytes/identity and rejects symlink or writable executable replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ci-qualification-file-'))
    try {
      const binary = join(root, 'binary'); await writeFile(binary, 'original bytes', { mode: 0o700 })
      const measured = await fingerprintQualificationPath(binary, true)
      expect(measured.sha256).toBe(createHash('sha256').update('original bytes').digest('hex'))
      await symlink(binary, join(root, 'alias'))
      await expect(fingerprintQualificationPath(join(root, 'alias'), true)).rejects.toThrow('canonical')
      await chmod(binary, 0o777)
      await expect(fingerprintQualificationPath(binary, true)).rejects.toThrow('trust boundary')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('only reuses an actually empty owned hook directory in the approved runtime root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ci-qualification-hooks-'))
    try {
      const hooks = await ensureEmptyPodmanHooks(root)
      expect(await ensureEmptyPodmanHooks(root)).toBe(hooks)
      await writeFile(join(hooks, 'unexpected.json'), '{}')
      await expect(ensureEmptyPodmanHooks(root)).rejects.toThrow('Empty owned hook directory')
      expect(hash({ path: hooks })).toMatch(/^[a-f0-9]{64}$/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

async function podmanProbeFixture() {
  const retained = JSON.parse(await readFile(
    new URL('../../../test/fixtures/podman-qualification-probe.json', import.meta.url), 'utf8',
  )) as { containerId: string; probe: Record<string, unknown> }
  const observed = {
    ...retained,
    probe: {
      ...retained.probe,
      environment: [...retained.probe.environment as string[], 'FOREMAN_CODE_JOB_INPUT_MANIFEST'].sort(),
    },
  }
  const original=candidate(),request=JobQualificationCandidateSchema.parse({...original,backingBytes:34359738368,
    fingerprint:{...original.fingerprint,limits:{cpuLimit:4,memoryBytes:6442450944,pidsLimit:256,diskBytes:34359738368}}})
  const host={hostPidNamespace:'pid:[1]',hostNetworkNamespace:'net:[2]',containerId:observed.containerId,containerHostname:observed.containerId.slice(0,12)}
  return {observed,request,host}
}
it('accepts only the managed HOSTNAME bound to original inspection and rejects missing/mismatched values and every other extra variable',async()=>{
  const {observed,request,host}=await podmanProbeFixture()
  // The retained old stdout lists HOSTNAME without its value. These controlled values test the new actual-value binding.
  const probe:Record<string,unknown>={...observed.probe,hostname:host.containerHostname}
  expect(()=>validateIsolationMeasurement(probe,request,host)).not.toThrow()
  for(const change of [{hostname:undefined},{hostname:''},{hostname:'parent-host'},{hostname:'other-container'},
    {environment:[...(probe.environment as string[]),'API_TOKEN'].sort()},
    {environment:[...(probe.environment as string[]),'HOSTNAME'].sort()},
  ])expect(()=>validateIsolationMeasurement({...probe,...change},request,host)).toThrow()
  expect(()=>validateIsolationMeasurement(probe,request,{...host,containerId:'unowned',containerHostname:host.containerHostname})).toThrow()
})
it('matches every other retained physical stdout guard with selected limits and keeps environment/namespace/resource refusals',async()=>{
  const {observed,request,host}=await podmanProbeFixture()
  const original={...observed.probe,environment:(observed.probe.environment as string[]).filter(name=>name!=='HOSTNAME')}
  expect(()=>validateIsolationMeasurement(original,request,host)).not.toThrow()
  for(const change of [{gitIndexWriteError:null},{memoryMax:'max'},{interfaces:['lo','eth0']},{environment:['API_TOKEN']}])
    expect(()=>validateIsolationMeasurement({...original,...change},request,host)).toThrow()
})

it('requires exactly four original binds with measured RO/RW modes and rejects old two-mount layout',()=>{
  const paths={sourceRoot:'/owned/tree',inputRoot:'/owned/tree/.graphql-job-inputs',gitDirectory:'/owned/repository',schedulerDirectory:'/owned/job-heavy-jobs'}
  const mounts=[{Type:'bind',Source:paths.sourceRoot,Destination:'/workspace',RW:true},
    {Type:'bind',Source:paths.inputRoot,Destination:'/workspace/.graphql-job-inputs',RW:false},
    {Type:'bind',Source:paths.gitDirectory,Destination:'/graphql-job-git',RW:false},
    {Type:'bind',Source:paths.schedulerDirectory,Destination:'/graphql-job-git/graphql-heavy-jobs',RW:true}]
  const tmpfs={'/tmp':'rw,nosuid,nodev,noexec,size=131072,rprivate,tmpcopyup'}
  expect(()=>validateJobQualificationMounts(mounts,paths,tmpfs,131072)).not.toThrow()
  expect(()=>validateJobQualificationMounts([mounts[0]!,mounts[1]!],paths,tmpfs,131072)).toThrow()
  expect(()=>validateJobQualificationMounts(mounts.map((item,index)=>index===2?{...item,RW:true}:item),paths,tmpfs,131072)).toThrow()
  expect(()=>validateJobQualificationMounts(mounts.map((item,index)=>index===3?{...item,Source:'/arbitrary/state'}:item),paths,tmpfs,131072)).toThrow()
})
it('invalidates historical two-mount qualification for the new layout without granting new capability',()=>{
  const request=candidate(),record={suite:'rootless-podman-ext4-volume-v1',candidate:request,fingerprint:jobQualificationFingerprint(request),outcome:'qualified',expiresAt:'2100-01-01T00:00:00Z'} as unknown as JobQualificationRecord
  expect(verifyJobQualification(record,request).reason).toBe('context_changed')
})

it('builds only qualifier-owned diagnostic Git objects, references and empty scheduler mountpoint without native entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-qualification-private-git-'))
  try {
    const tree = join(root, 'tree'), git = join(root, 'repository')
    await mkdir(tree, { mode: 0o700 })
    await prepareQualificationPrivateGit(git, tree)
    expect(await readdir(join(git, 'refs'))).toEqual([])
    expect(await readdir(join(git, 'graphql-heavy-jobs'))).toEqual([])
    const head = (await readFile(join(git, 'HEAD'), 'utf8')).trim()
    const commit = inflateSync(await readFile(join(git, 'objects', head.slice(0, 2), head.slice(2))))
    expect(createHash('sha1').update(commit).digest('hex')).toBe(head)
    expect(commit.toString()).toContain('Private Git mount qualification')
    const index = await readFile(join(git, 'index'))
    expect(index.subarray(0, 4).toString()).toBe('DIRC')
    expect(index.readUInt32BE(4)).toBe(2)
    expect(index.readUInt32BE(8)).toBe(0)
    expect(index.subarray(12)).toEqual(createHash('sha1').update(index.subarray(0, 12)).digest())
    expect(await readFile(join(tree, 'qualification.txt'), 'utf8')).toBe('original qualification snapshot')
    expect(await readFile(join(git, 'config'), 'utf8')).toContain(`worktree = ${tree}`)
    await expect(prepareQualificationPrivateGit(git, tree)).rejects.toMatchObject({ code: 'EEXIST' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps a historical fingerprint readable but denies new qualification before admission or probes', async () => {
  const request = candidate()
  delete request.fingerprint.workspaceLayout
  const authority = { readApproval: vi.fn(async () => ({ status: 'approved' as const,
    fingerprint: jobQualificationFingerprint(request), expiresAt: '2100-01-01T00:00:00Z' })),
    assertCurrent: vi.fn(), reserve: vi.fn() }
  expect((await qualifyJobRuntime(request, authority, new AbortController().signal)).reasons).toEqual(['workspace_layout_unqualified'])
  expect(authority.assertCurrent).not.toHaveBeenCalled()
  expect(authority.reserve).not.toHaveBeenCalled()
})
it('denies historical readiness without probing or silently upgrading immutable facts', async () => {
  const request = candidate(), runtime = { workspaceLayout: JOB_PRIVATE_GIT_LAYOUT }
  delete request.fingerprint.workspaceLayout
  const measurement = { origin: 'real-runtime', expiresAt: '2100-01-01T00:00:00Z', runtime, fingerprint: request.fingerprint }
  const profile = { status: 'qualified', measurement } as unknown as JobRuntimeProfile
  const dependencies = { descriptor: vi.fn(), immutableProfile: vi.fn(), admission: vi.fn(), currentMetadata: vi.fn() }
  const producer = createPhysicalJobRuntimeProducer(dependencies)
  expect(await producer.revalidate({ query: vi.fn() }, profile)).toEqual({ ready: false, reasons: ['unsupported_workspace_layout'] })
  expect(dependencies.currentMetadata).not.toHaveBeenCalled()
  expect(profile.status).toBe('qualified')
  expect('workspaceLayout' in measurement.fingerprint).toBe(false)
})
