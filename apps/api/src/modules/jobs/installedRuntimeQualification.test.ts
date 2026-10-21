import { nativeAgentEnvironment } from '../harnesses/secrets.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import type pg from 'pg'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { PostgresSourceService } from '../sources/service.js'
import type { InstalledJobRuntimeHost } from './runtimeProfileFactory.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { createJobQualificationCarrier } from './qualificationCarrier.js'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobRuntimeNativeAdmissionSchema } from '@foreman-code/contracts/job-runtime'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import * as processes from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { JobQualificationCandidateSchema, jobQualificationFingerprint } from './qualification.js'
import { reserveInstalledJobQualification, runInstalledJobRuntimeQualification,
  reconcileInstalledJobRuntimeQualification, recoverInstalledJobRuntimeQualifications } from './installedRuntimeQualification.js'
import * as installedHost from './installedRuntimeHost.js'
import { JobVerificationQualificationCandidateSchema, JobRuntimeNativeAdmissionRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { DeviceExecutionAdmissionFields } from '@foreman-code/contracts/device-resources'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { createVerificationProfile } from './verificationProfiles.js'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { startVerificationContainer } from './verificationQualification.js'
import { fingerprintQualificationPath } from './qualification.js'
import { JOB_INPUT_DIRECTORY } from '@foreman-code/contracts/job-inputs'

const id = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64)
const roots: string[] = [], journals: RemoteOperationJournal[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(journals.splice(0).map(value => value.close())); await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true }))) })
async function fixture() {
  const bootId = bootIdentity()
  const root = { version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
    selection: { hostRef: { kind: 'main', mainId: id }, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: id, rootId: id, bindingRevision: 1,
      locationRevision: 1, canonicalPath: '/approved/source', filesystem: { device: '12', inode: '34', mountId: '56' },
      accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest }, ownerPrincipalId: id, authorizedByPrincipalId: id,
    registration: null, attestationId: id, attestationDigest: digest, boundAt: '2026-10-01T00:00:00Z' }
  const candidate = JobQualificationCandidateSchema.parse({ qualificationId: id, operationId: id, approvalId: id,
    fingerprint: { schemaVersion: 1, profileId: id, profileRevision: 1, specDigest: digest, hostRef: { kind: 'main', mainId: id },
      registration: null, mainInstallationId: id, bootId, root, runtimeExecutable: process.execPath, runtimeBinarySha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
      ociExecutable: '/usr/bin/crun', ociBinarySha256: digest, imageDigest: `sha256:${digest}`, toolchainDigest: digest, configurationDigest: digest,
      limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 2097152 } },
    backingFile: '/approved/ci-volume.ext4', backingBytes: 2097152, findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: digest,
    controllerEnvironment: nativeAgentEnvironment(process.execPath, '/approved/runtime',
      { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' }), sourceParent: '/approved/source',
    runtimeRoot: '/approved/runtime', spoolBytes: 131072, ttlSeconds: 600 })
  const admission = JobRuntimeNativeAdmissionSchema.parse({ schemaVersion: 1, kind: 'job-runtime-qualification', approvalId: id,
    qualificationId: id, operationId: id, workspaceId: id, profileId: id, profileRevision: 1, fingerprintDigest: jobQualificationFingerprint(candidate),
    leaseId: id, runCommandId: 'real-command', runPrincipalId: 'real-running-principal', approvedByPrincipalId: 'real-human',
    hostRef: candidate.fingerprint.hostRef, registration: null, mainInstallationId: id, bootId, connection: null,
    admittedAt: new Date().toISOString(), expiresAt: '2100-01-01T00:00:00Z' })
  const directory = await privateFixtureDirectory('ci-native-journal-'); roots.push(directory)
  const path = join(directory, 'journal.json'), journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true }); journals.push(journal)
  const registry = { scope: vi.fn((owner: string) => ({ root: '/actual-registry', owner })), reserveLaunch: vi.fn(async () => ({ root: '/actual-registry', owner: `qualification:${id}:${id}`, launchId: randomUUID() })),
    closeRegistration: vi.fn(), abandonReservedLaunch: vi.fn(async () => true), closeOwner: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ revision: '1', launches: [] })) } as unknown as processes.NativeProcessRegistry
  const authority = { assertCurrent: vi.fn(), readApproval: vi.fn(async () => ({ status: 'approved' as const, fingerprint: admission.fingerprintDigest,
    expiresAt: admission.expiresAt })), reserve: vi.fn() }
  const host = { hostRef: admission.hostRef, registration: admission.registration, mainInstallationId: admission.mainInstallationId,
    bootId: admission.bootId, connection: admission.connection }
  const input = { admission, candidate, journal, registry, authority, host, assertAdmission: vi.fn(), signal: new AbortController().signal }
  return { ...input, input, path }
}


async function verificationReservationFixture() {
  const f = await fixture()
  f.candidate.fingerprint.root.binding.canonicalPath = dirname(f.path)
  const v = verificationRuntimeFixture()
  const now = new Date().toISOString()
  const profile = createVerificationProfile({ id, workspaceId: id, revision: 1, name: 'Verification replay',
    root: f.candidate.fingerprint.root, sourceCommit: v.measurement.fingerprint.sourceCommit!,
    spec: { rootId: id, bindingRevision: 1, resources: v.measurement.fingerprint.resources,
      policy: jobPolicyRequirementsRecord(v.spec.policy), suites: ['unit'],
      approvalConfig: { approvalLifetimeMs: 24 * 60 * 60 * 1000 } }, previous: null, now })
  const candidate = JobVerificationQualificationCandidateSchema.parse({ ...f.candidate,
    sourceParent: dirname(f.path), backingFile: null, backingBytes: null, volumeCapacityBytes: v.measurement.fingerprint.quota.volumeCapacityBytes,
    profile, approvedAt: now,
    fingerprint: { ...v.measurement.fingerprint, profileId: id, profileRevision: 1,
      specDigest: profile.specDigest, root: profile.root, hostRef: f.host.hostRef, registration: null,
      mainInstallationId: id, bootId: f.host.bootId, runtimeExecutable: process.execPath,
      runtimeBinarySha256: f.candidate.fingerprint.runtimeBinarySha256, resources: profile.spec.resources,
      approvalConfig: profile.approvalConfig } })
  const admission = JobRuntimeNativeAdmissionRecordSchema.parse({ ...f.admission, schemaVersion: 3,
    fingerprintDigest: jobQualificationFingerprint(candidate),
    ...Object.fromEntries(Object.keys(DeviceExecutionAdmissionFields).map(key => [key, Reflect.get(candidate.fingerprint, key)])),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })
  f.authority.readApproval.mockResolvedValue({ status: 'approved', fingerprint: admission.fingerprintDigest,
    expiresAt: admission.expiresAt })
  const input = { ...f.input, candidate, admission }
  return { ...f, input, candidate, admission }
}

describe('actual qualification reservation seams with mocked native entry only', () => {
  it('fingerprints every executable byte across full chunks and a partial final chunk', async () => {
    const f = await fixture()
    const path = join(dirname(f.path), 'runtime-binary')
    const bytes = Buffer.alloc(2 * 1048576 + 37, 0x5a)
    bytes[bytes.length - 1] = 0x31
    await writeFile(path, bytes, { mode: 0o700 })
    expect((await fingerprintQualificationPath(path, true)).sha256)
      .toBe(createHash('sha256').update(bytes).digest('hex'))
    bytes[1048576 + 11] = 0x32
    await writeFile(path, bytes)
    expect((await fingerprintQualificationPath(path, true)).sha256)
      .toBe(createHash('sha256').update(bytes).digest('hex'))
  })
  it('allows cold container creation within the approved preparation budget, then starts the original ID', async () => {
    const f = await verificationReservationFixture()
    f.candidate.profile.spec.policy.preparationTimeoutMs = 600000
    const root = dirname(f.path), containerId = 'd'.repeat(64)
    const owner = { registerContainer: vi.fn(async () => {}), observeContainer: vi.fn(async () => {}), enterContainer: vi.fn(async () => {}) }
    vi.useFakeTimers()
    try {
      const checked = vi.fn(async (argv: string[], timeout: number) => {
        if (!argv.includes('create')) return ''
        return new Promise<string>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('Preparation interrupted')), timeout)
          setTimeout(() => { clearTimeout(deadline); resolve(containerId) }, 31000)
        })
      })
      const preparation = startVerificationContainer({ candidate: f.candidate, owner, checked, plan: {
        identity: 'original-cold-container', sourceRoot: join(root, 'tree'), runtimeRoot: root,
        cwd: join(root, 'tree'), argv: ['node', '-e', 'setInterval(()=>{},1000)'],
        profile: { ...f.candidate.fingerprint.limits, imageDigest: f.candidate.fingerprint.imageDigest }, spoolBytes: 65536,
        labels: {}, inputRoot: join(root, 'tree', JOB_INPUT_DIRECTORY), gitDirectory: join(root, 'repository'), schedulerDirectory: join(root, 'job-heavy-jobs'),
      } })
      const assertion = expect(preparation).resolves.toBe(containerId)
      await vi.advanceTimersByTimeAsync(31000)
      await assertion
      expect(owner.observeContainer).toHaveBeenCalledWith('original-cold-container', containerId)
      expect(owner.enterContainer).toHaveBeenCalledWith('original-cold-container', containerId)
      expect(checked).toHaveBeenLastCalledWith(['start', containerId], 600000)
    } finally { vi.useRealTimers() }
  })
  it('does not close an active diagnostic launcher again after container cleanup closed it', async () => {
    const f = await fixture()
    const admitted = await reserveInstalledJobQualification(f.input)
    const identity = `graphql-ci-qualification-${id}`, containerId = 'd'.repeat(64)
    await admitted.ownership.reserveContainerIntent(identity, f.admission.fingerprintDigest)
    await admitted.ownership.bindContainer(identity, containerId)
    await admitted.ownership.publish({ scope: admitted.ownership.scope, containerId,
      process: { pid: 42, startTicks: '123', bootId: f.admission.bootId },
      boundary: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/libpod-${containerId}.scope`, device: '1', inode: '2' },
      helpers: [], lifecycle: 'closed' })
    const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() } }) as unknown as ReturnType<typeof processes.spawnNativeProcess>
    vi.spyOn(processes, 'spawnNativeProcess').mockReturnValue(child)
    const argv = ['--remote=false', 'exec', containerId, 'node', '-e', 'setInterval(()=>{},1000)']
    const launchId = await admitted.native.reserveProcess(process.execPath, argv)
    admitted.native.spawnProcess(launchId, process.execPath, argv,
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: f.candidate.controllerEnvironment })
    let closed = false
    vi.mocked(f.registry.closeRegistration).mockImplementation(async () => {
      if (closed) throw Object.assign(new Error('original launcher directory was removed'), { code: 'ENOENT' })
      closed = true
    })
    const cleanup = await admitted.native.reserveCleanupProcess!(process.execPath,
      ['--remote=false', 'container', 'inspect', containerId])
    expect(await admitted.native.stopProcess(cleanup)).toBe(true)
    expect(await admitted.native.close()).toBe(true)
    expect(f.registry.closeRegistration).toHaveBeenCalledOnce()
    expect((await f.journal.qualificationStatus(id))?.phase).toBe('closed')
  })
  it.each([125, 0, null])('retains failed-creation non-entry only after exact absent readback (create exit %s)', async exitCode => {
    const f = await fixture()
    await reserveInstalledJobQualification(f.input)
    const identity = `graphql-ci-qualification-${id}`
    await f.journal.qualificationContainerIntent(id, identity, f.admission.fingerprintDigest)
    const launchId = randomUUID()
    await f.journal.qualificationReserveProcess(id, { launchId, binary: process.execPath,
      argv: ['--remote=false', 'create', '--name', identity] })
    await f.journal.qualificationProcessExit(id, launchId, { exitCode, signal: exitCode === null ? 'SIGKILL' : null })
    await f.journal.qualificationProcessClosed(id, launchId)
    await expect(f.journal.qualificationCreationAbsent(id, identity)).rejects.toThrow('unconfirmed')
    if (exitCode !== 125) return
    const observationId = randomUUID()
    await f.journal.qualificationReserveCleanupProcess(id, { launchId: observationId, binary: process.execPath,
      argv: ['--remote=false', 'container', 'exists', identity] })
    await f.journal.qualificationProcessExit(id, observationId, { exitCode: 1, signal: null })
    await f.journal.qualificationProcessClosed(id, observationId)
    await f.journal.qualificationCreationAbsent(id, identity)
    await f.journal.qualificationClose(id)
    expect(await f.journal.qualificationStatus(id)).toMatchObject({ phase: 'closed', creationAbsent: true,
      container: { identity, containerId: null, certificate: null } })
  })
  it.each([false, true])('requires actual original-owner closure after interrupted creation (closed %s)', async closed => {
    const f = await fixture()
    const admitted = await reserveInstalledJobQualification(f.input)
    const identity = `graphql-ci-qualification-${id}`
    await f.journal.qualificationContainerIntent(id, identity, f.admission.fingerprintDigest)
    const createId = randomUUID()
    await f.journal.qualificationReserveProcess(id, { launchId: createId, binary: process.execPath,
      argv: ['--remote=false', 'create', '--name', identity] })
    await f.journal.qualificationProcessClosed(id, createId)
    const observationId = randomUUID()
    await f.journal.qualificationReserveCleanupProcess(id, { launchId: observationId, binary: process.execPath,
      argv: ['--remote=false', 'container', 'exists', identity] })
    await f.journal.qualificationProcessExit(id, observationId, { exitCode: 1, signal: null })
    await f.journal.qualificationProcessClosed(id, observationId)
    await expect(f.journal.qualificationCreationAbsent(id, identity)).rejects.toThrow('unconfirmed')
    vi.mocked(f.registry.closeOwner).mockResolvedValue(closed)
    if (closed) {
      expect(await admitted.ownership.confirmFailedCreation!(identity)).toBe(true)
      expect(f.registry.closeOwner).toHaveBeenCalled()
      expect(await f.journal.qualificationStatus(id)).toMatchObject({ creationAbsent: true })
      expect(await admitted.native.close()).toBe(true)
      expect(await f.journal.qualificationStatus(id)).toMatchObject({ phase: 'closed' })
    } else {
      await expect(admitted.ownership.confirmFailedCreation!(identity)).rejects.toThrow('unconfirmed')
      expect(await f.journal.qualificationStatus(id)).toMatchObject({ creationAbsent: false })
    }
  })
  it('retains a rejected entry check as a closed non-entry result without launching a diagnostic', async () => {
    const f = await fixture()
    const rejection = new Error('fixture runtime metadata changed')
    vi.spyOn(installedHost, 'inspectInstalledJobRuntimeCandidate').mockRejectedValue(rejection)
    const result = await runInstalledJobRuntimeQualification({ ...f.input, configuration: null })
    expect(result).toEqual({ outcome: 'denied', closure: 'confirmed', reasons: [rejection.message] })
    expect((await f.journal.qualificationStatus(id))?.phase).toBe('closed')
    expect((await f.journal.qualificationStatus(id))?.launches).toEqual([])
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  })
  it('reconciles a received diagnostic using its persisted non-entry fence', async () => {
    const f = await fixture()
    await f.journal.qualificationAccept(f.admission, f.candidate)
    expect(await reconcileInstalledJobRuntimeQualification(f.input)).toMatchObject({
      outcome: 'denied', closure: 'confirmed',
    })
    expect((await f.journal.qualificationStatus(id))?.phase).toBe('closed')
    expect(f.registry.closeOwner).not.toHaveBeenCalled()
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  })
  it('recovers previous-boot non-entry on the same installation without native work', async () => {
    const f = await fixture()
    await f.journal.qualificationAccept(f.admission,f.candidate)
    const previousBoot = randomUUID()
    const recoveredHost = { ...f.host,bootId:previousBoot }
    await recoverInstalledJobRuntimeQualifications({ journal:f.journal,registry:f.registry,host:recoveredHost })
    expect(await f.journal.qualificationStatus(id)).toMatchObject({ phase:'closed',launches:[],quotaClaims:[],
      admission:f.admission,result:{ outcome:'denied',closure:'confirmed' } })
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
    expect(f.registry.closeOwner).not.toHaveBeenCalled()
  })
  it('rejects a previous-boot entered operation and a different installation', async () => {
    const f = await fixture()
    await f.journal.qualificationAccept(f.admission,f.candidate)
    await expect(recoverInstalledJobRuntimeQualifications({ journal:f.journal,registry:f.registry,
      host:{ ...f.host,mainInstallationId:randomUUID(),bootId:randomUUID() } })).rejects.toThrow('Original qualification installation')
    await f.journal.qualificationReserveEntry(id)
    await expect(recoverInstalledJobRuntimeQualifications({ journal:f.journal,registry:f.registry,
      host:{ ...f.host,bootId:randomUUID() } })).rejects.toThrow('Original qualification installation')
    expect(await f.journal.qualificationStatus(id)).toMatchObject({ phase:'native_entry_attempted',result:null })
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  })
  it('reopens a closed verification diagnostic and returns its original result without another reservation', async () => {
    const f = await verificationReservationFixture()
    const { input, candidate } = f
    const reserved = await reserveInstalledJobQualification(input)
    expect(await reserved.native.close()).toBe(true)
    const result = { outcome: 'denied' as const, closure: 'confirmed' as const, reasons: ['original measured suite failure'] }
    await reserved.native.recordResult!(result)
    await f.journal.close()
    const reopened = await RemoteOperationJournal.open(f.path)
    journals.push(reopened)
    const replay = await reserveInstalledJobQualification({ ...input, journal: reopened })
    expect(replay.native.completedResult).toEqual(result)
    await expect(replay.native.reserveProcess(process.execPath, ['info'])).rejects.toThrow('cannot launch')
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
    expect((await reopened.qualificationStatus(id))?.candidate).toEqual(candidate)
  })
  it('denied approval and host mismatch perform no entry or registry reservation', async () => {
    const f = await fixture(); f.authority.readApproval.mockResolvedValue(null as never)
    await expect(reserveInstalledJobQualification(f.input)).rejects.toThrow('approval changed')
    expect(await f.journal.qualificationStatus(id)).toBeNull(); expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
    f.authority.readApproval.mockResolvedValue({ status: 'approved', fingerprint: f.admission.fingerprintDigest, expiresAt: f.admission.expiresAt })
    await expect(reserveInstalledJobQualification({ ...f.input, host: { ...f.host, bootId: id } })).rejects.toThrow('context changed')
    expect(await f.journal.qualificationStatus(id)).toBeNull()
  })
  it('reopened original entry rejects another launch instead of replacing uncertain work', async () => {
    const f = await fixture(); await reserveInstalledJobQualification(f.input)
    await f.journal.close(); const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    const recovered = await reserveInstalledJobQualification({ ...f.input, journal: reopened })
    expect(recovered.native.recoveryRequired).toBe(true)
    await expect(recovered.native.reserveProcess(process.execPath, ['--remote=false', 'info'])).rejects.toThrow('executable/argv')
    expect(await recovered.native.close()).toBe(true)
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  })
  it.each(['timeout', 'disconnect', 'expiry'] as const)('retains only original-container cleanup authority after %s', async reason => {
    const f = await fixture()
    let now = Date.now()
    const controller = new AbortController()
    const admitted = await reserveInstalledJobQualification({ ...f.input, signal: controller.signal, now: () => now })
    const containerId = 'b'.repeat(64)
    await admitted.ownership.reserveContainerIntent(`graphql-ci-qualification-${id}`, f.admission.fingerprintDigest)
    await admitted.ownership.bindContainer(`graphql-ci-qualification-${id}`, containerId)
    if (reason === 'timeout') controller.abort()
    if (reason === 'disconnect') f.input.assertAdmission.mockRejectedValue(new Error('channel closed'))
    if (reason === 'expiry') now = Date.parse(f.admission.expiresAt) + 1
    await expect(admitted.native.reserveProcess(process.execPath, ['--remote=false', 'info'])).rejects.toThrow()
    const cleanup = await admitted.native.reserveCleanupProcess!(process.execPath,
      ['--remote=false', 'container', 'inspect', containerId])
    expect(cleanup).toBeTruthy()
    for (const argv of [['--remote=false', 'start', containerId], ['--remote=false', 'info'],
      ['--remote=false', 'stop', '--time', '1', 'c'.repeat(64)]]) {
      await expect(admitted.native.reserveCleanupProcess!(process.execPath, argv)).rejects.toThrow('Only original-container')
    }
    expect((await f.journal.qualificationStatus(id))?.phase).toBe('native_entry_attempted')
  })

  it('retains quota claims until positive closure and reclaims only the original owner after restart', async () => {
    const f = await verificationReservationFixture()
    const admitted = await reserveInstalledJobQualification(f.input)
    const slot = f.candidate.fingerprint.quotaPool!.slots[0]!
    const namespace = join(f.candidate.sourceParent, slot.namespace, id)
    await mkdir(namespace, { recursive: true, mode: 0o700 })
    const path = join(f.candidate.sourceParent, `quota-${slot.namespace}.claim.json`)
    await writeFile(path, JSON.stringify({ kind: 'qualification', qualificationId: id, operationId: id }), { mode: 0o600 })
    const metadata = await stat(path)
    await admitted.native.recordQuotaClaim!({ path, namespace, device: metadata.dev, inode: metadata.ino })
    await expect(import('./installedRuntimeQualification.js').then(module => module.releaseQualificationQuotaClaims(f.journal, id)))
      .rejects.toThrow('Positive qualification closure')
    expect((await f.journal.qualificationStatus(id))?.quotaClaims)
      .toEqual([{ path, namespace, device: metadata.dev, inode: metadata.ino }])
    await f.journal.close()
    const reopened = await RemoteOperationJournal.open(f.path)
    journals.push(reopened)
    const recovered = await reserveInstalledJobQualification({ ...f.input, journal: reopened, entry: 'reconcile',
      signal: AbortSignal.abort(new Error('original caller disconnected')) })
    await expect(recovered.native.reserveProcess(process.execPath, ['--remote=false', 'info'])).rejects.toThrow()
    expect(await recovered.native.close()).toBe(true)
    expect((await reopened.qualificationStatus(id))?.quotaClaims)
      .toEqual([{ path, namespace, device: metadata.dev, inode: metadata.ino }])
    expect(await reconcileInstalledJobRuntimeQualification({ ...f.input, journal: reopened,
      signal: AbortSignal.abort(new Error('original caller disconnected')) }))
      .toMatchObject({ outcome: 'denied', closure: 'confirmed' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(namespace)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await reopened.qualificationStatus(id))?.quotaClaims).toEqual([])
  })

  it.each(['execute','reconcile'] as const)('uses bounded carrier calls for %s while retaining original ownership', async intent => {
    const f = await verificationReservationFixture()
    const deviceId = randomUUID()
    const registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
    const hostRef = { kind: 'device' as const, mainId: id, deviceId }
    const binding = { mainId: id, deviceId, ...registration, bootId: f.host.bootId,
      connectionGeneration: 1, connectionEpoch: randomUUID() }
    const root = structuredClone(f.candidate.fingerprint.root)
    root.selection.hostRef = hostRef
    root.registration = registration
    root.binding.deviceId = deviceId
    root.binding.workerInstallationId = registration.workerInstallationId
    const candidate = JobVerificationQualificationCandidateSchema.parse({ ...f.candidate,
      profile: { ...f.candidate.profile, root },
      fingerprint: { ...f.candidate.fingerprint, root, hostRef, registration } })
    const admission = JobRuntimeNativeAdmissionRecordSchema.parse({ ...f.admission, hostRef, registration,
      connection: binding, fingerprintDigest: jobQualificationFingerprint(candidate) })
    let now = Date.now()
    if (intent === 'reconcile') now = Date.parse(admission.expiresAt) + 1
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const result = { outcome: 'denied' as const, closure: 'confirmed' as const, reasons: ['measured suite failed'] }
    const request = vi.fn(async (payload: unknown, options: { timeoutMs?: number }) => {
      expect(options.timeoutMs).toBe(30000)
      const operation = (payload as { operation: string }).operation
      const first = request.mock.calls.length === 1
      const missing = first && intent === 'execute'
      const complete = operation === 'status' && !first
      if (operation === 'start') now += 16 * 60 * 1000
      let phase = 'running'
      if (missing) phase = 'not_started'
      if (first && intent === 'reconcile') phase = 'received'
      if (complete) phase = 'complete'
      return { payload: { version: 3, operation, admission, candidate, phase, result: complete ? result : null } }
    })
    const endpoint = { currentBinding: () => binding, captureRequest: () => ({ binding, request }) } as unknown as DeviceEndpoint
    const carrier = createJobQualificationCarrier({ pool: {} as pg.Pool, sources: {} as PostgresSourceService,
      endpoint: () => endpoint, local: {} as InstalledJobRuntimeHost,
      workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }) })
    const assertAdmission = vi.fn(async () => undefined)
    expect(await carrier.host.runAdmitted!({ profile: candidate.profile, candidate, nativeAdmission: admission,
      assertAdmission, signal: new AbortController().signal, approval: {} as never, descriptor: {} as never,intent })).toEqual(result)
    const operations = intent === 'execute' ? ['status','start','status'] : ['status','status']
    expect(request.mock.calls.map(([payload]) => (payload as { operation: string }).operation)).toEqual(operations)
    expect(request.mock.calls.every(([payload]) =>
      (payload as { admission: { expiresAt: string } }).admission.expiresAt === admission.expiresAt)).toBe(true)
    expect(assertAdmission).toHaveBeenCalledTimes(2)
  })

  it('Main admission denial never reserves native entry and is rechecked before later commands', async () => {
    const f = await fixture()
    f.input.assertAdmission.mockRejectedValueOnce(new Error('revoked original authority'))
    await expect(reserveInstalledJobQualification(f.input)).rejects.toThrow('revoked original authority')
    expect(await f.journal.qualificationStatus(id)).toBeNull()
    const admitted = await reserveInstalledJobQualification(f.input)
    f.input.assertAdmission.mockRejectedValueOnce(new Error('revoked original authority'))
    await expect(admitted.native.reserveProcess(process.execPath, ['--remote=false', 'info'])).rejects.toThrow('revoked original authority')
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  })
  it('persists registry reservation before mocked spawn and refuses command/env substitution', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input)
    const spawn = vi.spyOn(processes, 'spawnNativeProcess').mockImplementation(() => { throw new Error('must not launch') })
    const reservation = await admitted.native.reserveProcess(process.execPath, ['--remote=false', 'info'])
    expect((await f.journal.qualificationStatus(id))?.launches[0]).toMatchObject({ launchId: reservation, binary: process.execPath, argv: ['--remote=false', 'info'] })
    expect(() => admitted.native.spawnProcess(reservation, process.execPath, ['--remote=false', 'start'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: f.candidate.controllerEnvironment })).toThrow('entry changed')
    expect(() => admitted.native.spawnProcess(reservation, process.execPath, ['--remote=false', 'info'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...f.candidate.controllerEnvironment, SECRET: 'forbidden' } })).toThrow('entry changed')
    expect(spawn).not.toHaveBeenCalled()
    expect(await admitted.native.close()).toBe(true)
    expect(f.registry.abandonReservedLaunch).toHaveBeenCalled()
  })
  it('prepares the reserved executable PATH without changing the reviewed controller environment', async () => {
    const f = await fixture()
    f.candidate.controllerEnvironment.PATH = '/approved/helpers:/usr/bin:/bin'
    const originalEnvironment = { ...f.candidate.controllerEnvironment }
    const admitted = await reserveInstalledJobQualification(f.input)
    const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() } }) as unknown as
      ReturnType<typeof processes.spawnNativeProcess>
    const spawn = vi.spyOn(processes, 'spawnNativeProcess').mockReturnValue(child)
    const argv = ['--remote=false', 'info']
    const reservation = await admitted.native.reserveProcess(process.execPath, argv)
    admitted.native.spawnProcess(reservation, process.execPath, argv, {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: originalEnvironment,
    })
    expect(spawn).toHaveBeenCalledWith(process.execPath, argv, expect.objectContaining({
      env: nativeAgentEnvironment(process.execPath, f.candidate.runtimeRoot, originalEnvironment),
    }))
    expect(f.candidate.controllerEnvironment).toEqual(originalEnvironment)
    expect(() => admitted.native.spawnProcess(reservation, process.execPath, argv, {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...originalEnvironment, SECRET: 'forbidden' },
    })).toThrow('entry changed')
  })
  it('wrapper zero alone cannot become confirmed native success', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input)
    const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() } }) as unknown as ReturnType<typeof processes.spawnNativeProcess>
    vi.spyOn(processes, 'spawnNativeProcess').mockReturnValue(child)
    const exit = vi.spyOn(processes, 'nativeProcessExit').mockReturnValue({ exitCode: null, exitSignal: null })
    const reservation = await admitted.native.reserveProcess(process.execPath, ['--remote=false', 'info'])
    admitted.native.spawnProcess(reservation, process.execPath, ['--remote=false', 'info'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: f.candidate.controllerEnvironment })
    expect(await admitted.native.readNativeExit(reservation, child, { exitCode: 0, signal: null })).toEqual({ confirmed: false, exitCode: null })
    exit.mockReturnValue({ exitCode: 0, exitSignal: null })
    expect(await admitted.native.readNativeExit(reservation, child, { exitCode: 1, signal: null })).toEqual({ confirmed: true, exitCode: 0 })
    expect(f.registry.closeRegistration).toHaveBeenCalled()
    await expect(admitted.native.readNativeExit(reservation, new EventEmitter() as ChildProcess, { exitCode: 0, signal: null })).rejects.toThrow('target changed')
  })
  it('allows removal only for the original container after its closure is retained', async () => {
    const f = await fixture()
    const admitted = await reserveInstalledJobQualification(f.input)
    const identity = `graphql-ci-qualification-${id}`
    const containerId = 'b'.repeat(64)
    await admitted.ownership.reserveContainerIntent(identity, f.admission.fingerprintDigest)
    await admitted.ownership.bindContainer(identity, containerId)
    const certificate = { scope: admitted.ownership.scope, containerId,
      process: { pid: 42, startTicks: '123', bootId: f.admission.bootId },
      boundary: { kind: 'cgroup-v2' as const, path: `/sys/fs/cgroup/libpod-${containerId}.scope`,
        device: '1', inode: '2' }, helpers: [], lifecycle: 'active' as const }
    await admitted.ownership.publish(certificate)
    const remove = ['--remote=false', 'rm', '--volumes', containerId]
    await expect(admitted.native.reserveCleanupProcess!(process.execPath, remove)).rejects.toThrow('Only original-container')
    await admitted.ownership.publish({ ...certificate, lifecycle: 'closed' })
    for (const argv of [remove, ['--remote=false', 'container', 'exists', containerId]]) {
      expect(await admitted.native.reserveCleanupProcess!(process.execPath, argv)).toBeTruthy()
    }
    for (const argv of [['--remote=false', 'rm', '--force', containerId],
      ['--remote=false', 'rm', '--volumes', 'c'.repeat(64)]]) {
      await expect(admitted.native.reserveCleanupProcess!(process.execPath, argv)).rejects.toThrow('Only original-container')
    }
    expect(await admitted.native.close()).toBe(true)
  })
  // Rewrites a 512-launch journal and replays it twice; under full-suite load this exceeds the 5 s default.
  it('retains cleanup capacity after the diagnostic command budget is exhausted', async () => {
    const f = await fixture()
    const admitted = await reserveInstalledJobQualification(f.input)
    const containerId = 'b'.repeat(64)
    const identity = `graphql-ci-qualification-${id}`
    await admitted.ownership.reserveContainerIntent(identity, f.admission.fingerprintDigest)
    await admitted.ownership.bindContainer(identity, containerId)
    await admitted.ownership.publish({ scope: admitted.ownership.scope, containerId,
      process: { pid: 42, startTicks: '123', bootId: f.admission.bootId },
      boundary: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/libpod-${containerId}.scope`, device: '1', inode: '2' },
      helpers: [], lifecycle: 'closed' })
    await f.journal.close()
    const persisted = JSON.parse(await readFile(f.path, 'utf8'))
    const launches = Array.from({ length: 512 }, () => ({ launchId: randomUUID(), binary: process.execPath,
      argv: ['--remote=false', 'container', 'inspect', containerId], exit: { exitCode: 0, signal: null }, closed: true }))
    persisted.qualificationReceipts[0].launches = launches
    await writeFile(f.path, JSON.stringify(persisted))
    const journal = await RemoteOperationJournal.open(f.path)
    journals.push(journal)
    await expect(journal.qualificationReserveProcess(id, { launchId: randomUUID(), binary: process.execPath,
      argv: ['--remote=false', 'info'] })).rejects.toThrow('reservation unavailable')
    const recovered = await reserveInstalledJobQualification({ ...f.input, journal, entry: 'reconcile' })
    for (let attempt = 0; attempt < 16; attempt++) {
      const launchId = await recovered.native.reserveCleanupProcess!(process.execPath,
        ['--remote=false', 'container', 'exists', containerId])
      expect(await recovered.native.stopProcess(launchId)).toBe(true)
    }
    await expect(recovered.native.reserveCleanupProcess!(process.execPath,
      ['--remote=false', 'container', 'exists', containerId])).rejects.toThrow('reservation unavailable')
    expect((await journal.qualificationStatus(id))?.launches.slice(0, 512)).toEqual(launches)
  }, 30_000)
  it.each([[false, 1], [true, 0], [true, 1]] as const)(
    'observes interrupted creation once after exhausted cleanup (owner closed %s, exists exit %s)',
    async (ownerClosed, exitCode) => {
      const f = await fixture()
      const admitted = await reserveInstalledJobQualification(f.input)
      const identity = `graphql-ci-qualification-${id}`
      await admitted.ownership.reserveContainerIntent(identity, f.admission.fingerprintDigest)
      await f.journal.close()
      const persisted = JSON.parse(await readFile(f.path, 'utf8'))
      const launches = Array.from({ length: 528 }, (_, index) => ({ launchId: randomUUID(), binary: process.execPath,
        argv: index === 0 ? ['--remote=false', 'create', '--name', identity]
          : ['--remote=false', 'container', 'inspect', identity],
        exit: index === 0 ? null : { exitCode: 125, signal: null }, closed: true }))
      persisted.qualificationReceipts[0].launches = launches
      await writeFile(f.path, JSON.stringify(persisted))
      const journal = await RemoteOperationJournal.open(f.path)
      journals.push(journal)
      vi.mocked(f.registry.closeOwner).mockResolvedValue(ownerClosed)
      const spawn = vi.spyOn(processes, 'spawnNativeProcess').mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() },
          stdout: new EventEmitter(), stderr: new EventEmitter() })
        setImmediate(() => child.emit('close', exitCode, null))
        return child as unknown as ReturnType<typeof processes.spawnNativeProcess>
      })
      vi.spyOn(processes, 'nativeProcessExit').mockReturnValue({ exitCode, exitSignal: null })
      const result = await reconcileInstalledJobRuntimeQualification({ ...f.input, journal })
      const closed = ownerClosed && exitCode === 1
      expect(result).toMatchObject({ outcome: 'denied', closure: closed ? 'confirmed' : 'unconfirmed' })
      const receipt = await journal.qualificationStatus(id)
      expect(receipt?.launches.slice(0, 528)).toEqual(launches)
      expect(receipt?.launches).toHaveLength(ownerClosed ? 529 : 528)
      expect(receipt?.phase === 'closed').toBe(closed)
      expect(f.registry.closeOwner).toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledTimes(Number(ownerClosed))
      if (ownerClosed) expect(spawn).toHaveBeenCalledWith(process.execPath,
        ['--remote=false', 'container', 'exists', identity], expect.anything())
      const recovered = await reserveInstalledJobQualification({ ...f.input, journal, entry: 'reconcile' })
      await expect(recovered.native.reserveProcess(process.execPath, ['--remote=false', 'create']))
        .rejects.toThrow()
      if (!closed && ownerClosed) await expect(recovered.native.reserveCleanupProcess!(process.execPath,
        ['--remote=false', 'container', 'exists', identity])).rejects.toThrow('reservation unavailable')
    })
  it('container identity/certificate and positive closure persist on the same journal', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input), ownership = admitted.ownership
    const identity = `graphql-ci-qualification-${id}`, containerId = 'b'.repeat(64)
    await ownership.reserveContainerIntent(identity, f.admission.fingerprintDigest)
    await ownership.bindContainer(identity, containerId)
    await expect(ownership.bindContainer(identity, 'c'.repeat(64))).rejects.toThrow('identity changed')
    const scope = ownership.scope
    expect('owner' in scope).toBe(false)
    const certificate = { scope, containerId, process: { pid: 42, startTicks: '123', bootId: f.admission.bootId },
      boundary: { kind: 'cgroup-v2' as const, path: `/sys/fs/cgroup/libpod-${containerId}.scope`, device: '1', inode: '2' }, helpers: [], lifecycle: 'active' as const }
    await ownership.publish(certificate)
    await expect(admitted.native.close()).rejects.toThrow('closure unconfirmed')
    await ownership.publish({ ...certificate, lifecycle: 'closed' })
    expect(await admitted.native.close()).toBe(true)
    await f.journal.close(); const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    expect((await reopened.qualificationStatus(id))?.container?.certificate?.lifecycle).toBe('closed')
    await expect(reopened.qualificationCertificate(id, { ...certificate, lifecycle: 'active' })).rejects.toThrow('identity changed')
  })
  it('lost result acknowledgment replays persisted original diagnostic result after reopening without native entry', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input)
    await admitted.native.close()
    const result = { outcome: 'denied' as const, closure: 'confirmed' as const, reasons: ['original diagnostic failed'] }
    await f.journal.qualificationResult(id, result)
    await expect(f.journal.qualificationResult(id, { ...result, reasons: ['replacement result'] })).rejects.toThrow('result changed')
    await f.journal.close(); const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    vi.spyOn(installedHost, 'inspectInstalledJobRuntimeCandidate').mockResolvedValue()
    expect(await runInstalledJobRuntimeQualification({ ...f.input, configuration: null, journal: reopened })).toEqual(result)
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
    await expect(reopened.qualificationAccept(f.admission, { ...f.candidate, ttlSeconds: 1 })).rejects.toThrow('admission conflict')
  })
})
