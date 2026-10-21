import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteJobDispatchIntent } from '@foreman-code/contracts/remote-job-execution'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { DomainError } from '../errors.js'
import { identity } from '../sources/privateFilesystem.js'
import * as privateFilesystem from '../sources/privateFilesystem.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { RemoteJobExecutionHost, type RemoteJobExecutionHostPorts } from '../runs/remote/jobExecutionHost.js'
import { createInstalledJobExecutionPorts, authorizeJobContainerEntry } from './executorInstalled.js'
import { JobRuntimeNativeAdmissionSchema } from '@foreman-code/contracts/job-runtime'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'
import { jobRuntimeMetadataFixture } from '../../../test/helpers/jobRuntimeMetadataFixture.js'
import { QualificationReceiptSchema } from './qualificationJournal.js'
import { jobDigest } from './service.js'
import * as installed from './installedRuntimeHost.js'
import * as qualification from './qualification.js'
import * as processes from '../harnesses/recovery/processRegistry.js'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { jobSupervisorIdentity } from './executor.js'
import * as git from './privateGitMounts.js'
import { podmanIsolationCreateArgv } from './executorPodman.js'
import type { QualifiedJobProfile } from './executor.js'

const roots: string[] = [], journals: RemoteOperationJournal[] = [], hosts: RemoteJobExecutionHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.drain()))
  vi.restoreAllMocks()
  await Promise.all(journals.splice(0).map(journal => journal.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function filesystem(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { return await identity(handle) } finally { await handle.close() }
}
async function fixture(qualifiedFilesystem?: { device?: string; mountId?: string }) {
  const root = await privateFixtureDirectory('installed-job-'); roots.push(root)
  const execution = jobExecution(), parent = join(root, execution.acceptedSpec.source.materializationId)
  execution.acceptedSpec.target.mainInstallationId = execution.acceptedSpec.target.mainId
  await mkdir(parent, { mode: 0o700 })
  for (const directory of ['tree', 'repository', 'job-heavy-jobs']) await mkdir(join(parent, directory), { mode: 0o700 })
  Object.assign(execution.acceptedSpec.target.destination, { canonicalProjectRoot: join(parent, 'tree'), canonicalCwd: join(parent, 'tree'), managedRuntimeRoot: join(root, 'runtime') })
  Object.assign(execution.acceptedSpec, jobSpecDigests(execution.acceptedSpec, execution.acceptedSpec.workflowInput))
  const spec = execution.acceptedSpec, digest = 'a'.repeat(64), bootId = bootIdentity()
  const mounts: git.VerifiedJobGitMounts = { version: 1, layout: git.JOB_PRIVATE_GIT_LAYOUT, workspaceId: execution.workspaceId,
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, owner: structuredClone(execution.owner),
    specDigest: spec.specDigest, bindingHash: spec.bindingHash, materializationId: spec.source.materializationId, materializationDigest: spec.source.materializationDigest,
    git: { directory: join(parent, 'repository'), filesystem: await filesystem(join(parent, 'repository')), generatedCommit: '4'.repeat(40), sourceCommit: spec.source.commit,
      repositoryReceiptDigest: digest, configDigest: digest, indexDigest: digest, mountpoint: await filesystem(join(parent, 'repository')) },
    scheduler: { directory: join(parent, 'job-heavy-jobs'), filesystem: await filesystem(join(parent, 'job-heavy-jobs')) }, receiptDigest: digest }
  const profile: QualifiedJobProfile = { workspaceLayout: git.JOB_PRIVATE_GIT_LAYOUT, policyId: spec.policy.isolationPolicyId,
    policyRevision: spec.policy.isolationPolicyRevision, imageDigest: spec.policy.imageDigest, toolchainDigest: spec.policy.toolchainDigest,
    runtimeVersion: 'fixture', ociRuntimeVersion: 'fixture', kernelVersion: 'fixture', qualificationId: randomUUID(), rootless: true,
    cgroupV2: true, filesystemBounded: true, descendantContainment: true, network: 'none', cpuLimit: 1, memoryBytes: 1048576, pidsLimit: 64, diskBytes: 1048576 }
  // Qualification is a schema-validated boundary double; directory checks use real Linux FDs.
  const base = buildComputerFixture(spec.target.mainId, execution.workspaceId).candidate.profile
  const savedRoot = SourceRootRecordSchema.parse({ ...base.root,
    source: { approvedSourceId: spec.source.approvedSourceId, snapshotId: spec.source.snapshotId,
      manifestDigest: spec.source.manifestDigest },
    selection: { hostRef: spec.target.hostRef, rootPolicyId: spec.target.destination.rootPolicyId,
      rootPolicyRevision: spec.target.destination.rootPolicyRevision, locationRevision: spec.target.destination.locationRevision },
    registration: null, binding: { ...base.root.binding, deviceId: null, workerInstallationId: null,
      canonicalPath: root, snapshotId: spec.source.snapshotId, manifestDigest: spec.source.manifestDigest,
      filesystem: { ...await filesystem(root), ...qualifiedFilesystem } } })
  const metadata = jobRuntimeMetadataFixture({ ...base, id: spec.policy.isolationPolicyId,
    root: savedRoot, policy: spec.policy, limits: { cpuLimit: profile.cpuLimit, memoryBytes: profile.memoryBytes,
      pidsLimit: profile.pidsLimit, diskBytes: profile.diskBytes } }, bootId)
  const measurement = metadata.profile.measurement!
  const fingerprint = metadata.fingerprint
  const admission = JobRuntimeNativeAdmissionSchema.parse({ schemaVersion: 1, kind: 'job-runtime-qualification',
    approvalId: measurement.approvalId, qualificationId: measurement.qualificationId,
    operationId: measurement.qualificationId,
    workspaceId: execution.workspaceId, profileId: metadata.profile.id, profileRevision: metadata.profile.revision,
    fingerprintDigest: jobDigest(fingerprint), leaseId: randomUUID(), runCommandId: 'qualify', runPrincipalId: 'runner',
    approvedByPrincipalId: 'owner', hostRef: fingerprint.hostRef, registration: fingerprint.registration,
    mainInstallationId: fingerprint.mainInstallationId, bootId, connection: null,
    admittedAt: measurement.checkedAt, expiresAt: measurement.expiresAt })
  const qualified = QualificationReceiptSchema.parse({ admission,
    candidate: { fingerprint, sourceParent: root, runtimeRoot: spec.target.destination.managedRuntimeRoot,
      qualificationId: admission.qualificationId, approvalId: admission.approvalId, operationId: admission.operationId,
      findmntBinary: metadata.descriptor.findmntExecutable, findmntBinarySha256: metadata.descriptor.findmntBinarySha256,
      backingFile: metadata.descriptor.backingFile, backingBytes: profile.diskBytes,
      controllerEnvironment: metadata.descriptor.controllerEnvironment, spoolBytes: 131072, ttlSeconds: 3600 },
    result: { outcome: 'qualified', measurement }, sequence: 1, phase: 'closed', launches: [], container: null })
  const journal = await RemoteOperationJournal.open(join(root, 'journal'), { initializeNewInstallation: true }); journals.push(journal)
  vi.spyOn(journal, 'qualifiedJobRuntime').mockResolvedValue(qualified)
  const inspect = vi.spyOn(installed, 'inspectInstalledJobRuntimeCandidate').mockResolvedValue(undefined)
  const verify = vi.spyOn(git, 'verifyJobGitMounts').mockResolvedValue(undefined)
  const intent: RemoteJobDispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: spec.target.mainId,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: spec.definitionId },
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: spec.bindingHash,
    inputDigest: `sha256:${spec.specDigest}`, owner: execution.owner }
  const connection = { kind: 'main' as const, mainId: intent.mainId, mainInstallationId: spec.target.mainInstallationId, bootId }
  const source: Awaited<ReturnType<RemoteJobExecutionHostPorts['source']['verify']>> = {
    privateRepositoryRoot: spec.target.destination.canonicalProjectRoot, directoryIdentityHash: spec.target.destination.directoryIdentityHash,
    privateGit: true, diskQuotaBytes: 1024, gitMounts: mounts }
  const inputs = { prepare: vi.fn(async () => { throw new DomainError('SOURCE_IDENTITY_MISMATCH', 'Stop after source verification', 409) }) }
  const registry = { reserveLaunch: vi.fn(async () => { throw new Error('No OCI entry expected') }) }
  const ports = createInstalledJobExecutionPorts({ journal, connection, incarnationId: randomUUID(), registry: registry as unknown as NativeProcessRegistry,
    configuration: null, source: { verify: vi.fn(async () => source) }, inputs, authorize: vi.fn(async () => {}),
    appendLog: vi.fn(), observeReceipt: vi.fn(), collectOutputs: vi.fn() })
  const host = new RemoteJobExecutionHost(ports); hosts.push(host)
  await journal.jobAccept(intent, execution, connection, randomUUID())
  if (typeof ports.supervisor !== 'function') throw new Error('Installed supervisor factory missing')
  await ports.supervisor(execution)
  const check = (signal = new AbortController().signal) => ports.source.verify(structuredClone(spec), signal)
  return { root, execution, source, mounts, journal, qualified, inspect, verify, check, ports, host, intent, registry, inputs }
}
describe('installed Job original Git/scheduler propagation', () => {
  it('releases a completed admission so later work with the same spec remains unambiguous', async () => {
    const f = await fixture()
    await f.host.deliver(f.intent, f.execution)
    await f.host.drain()
    expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
      terminal: { outcome: 'preparation_failed', processStopped: true }, publication: 'complete',
    } })
    const successor = structuredClone(f.execution)
    successor.id = randomUUID()
    successor.attemptId = randomUUID()
    successor.operationId = randomUUID()
    const intent: RemoteJobDispatchIntent = {
      ...f.intent,
      executionId: successor.id,
      attemptId: successor.attemptId,
      operationId: successor.operationId,
      subject: { kind: 'manual-job', workspaceId: successor.workspaceId,
        jobExecutionId: successor.id, definitionId: successor.acceptedSpec.definitionId },
    }
    await f.journal.jobAccept(intent, successor, {
      kind: 'main', mainId: intent.mainId,
      mainInstallationId: successor.acceptedSpec.target.mainInstallationId, bootId: bootIdentity(),
    }, randomUUID())
    Object.assign(f.mounts, { executionId: successor.id,
      attemptId: successor.attemptId, operationId: successor.operationId })
    expect(successor.acceptedSpec).toEqual(f.execution.acceptedSpec)
    if (typeof f.ports.supervisor !== 'function') throw new Error('Installed supervisor factory missing')
    await f.ports.supervisor(successor)
    await expect(f.ports.source.verify(successor.acceptedSpec, new AbortController().signal)).resolves.toBe(f.source)
  })

  it('reconstructs a completed supervisor from retained qualification instead of retaining its runtime state', async () => {
    const f = await fixture()
    if (typeof f.ports.supervisor !== 'function') throw new Error('Installed supervisor factory missing')
    const original = await f.ports.supervisor(f.execution)
    expect(await f.ports.supervisor(f.execution)).toBe(original)
    await f.host.deliver(f.intent, f.execution)
    await f.host.drain()
    const reads = vi.mocked(f.journal.qualifiedJobRuntime).mock.calls.length
    const recovered = await f.ports.supervisor(f.execution)
    expect(vi.mocked(f.journal.qualifiedJobRuntime).mock.calls.length).toBeGreaterThan(reads)
    expect(recovered.qualifiedProfile).toEqual(original.qualifiedProfile)
  })

  it.each([false, true])('closes only recorded controller roles for an absent unentered container (unrecorded active %s)', async unknownActive => {
    const f = await fixture(), owner = `job:${f.execution.operationId}:${f.execution.owner.grantId}:${f.execution.owner.epoch}`
    const control = `${owner}:control`, exits = new Map<object, number>()
    vi.spyOn(qualification, 'assertJobRuntimeEntryContext').mockResolvedValue(undefined)
    Object.assign(f.registry, {
      reserveLaunch: vi.fn(async () => ({ root: f.root, owner: control, launchId: randomUUID() })),
      closeRegistration: vi.fn(),
      closeOwner: vi.fn(async (value: string) => value === control),
      snapshot: () => ({ launches: unknownActive ? [{ owner: control, lifecycle: 'active', launchId: randomUUID() }] : [] }),
    })
    vi.spyOn(processes, 'nativeProcessExit').mockImplementation(child => ({ exitCode: exits.get(child) ?? null, exitSignal: null }))
    vi.spyOn(processes, 'spawnNativeProcess').mockImplementation((_binary, argv) => {
      const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() }, stdout: new PassThrough(), stderr: new PassThrough() })
      setImmediate(() => {
        const exitCode = argv.includes('exists') ? 1 : 125
        exits.set(child, exitCode); child.stdout.end(); child.stderr.end(); child.emit('close', exitCode, null)
      })
      return child as unknown as ReturnType<typeof processes.spawnNativeProcess>
    })
    await f.journal.jobReserveEntry(f.execution.operationId)
    await f.journal.jobContainerIntent(f.execution.operationId, jobSupervisorIdentity(f.execution), f.execution.acceptedSpec.specDigest)
    if (typeof f.ports.supervisor !== 'function') throw new Error('Supervisor factory unavailable')
    const supervisor = await f.ports.supervisor(f.execution)
    expect(await supervisor.stopExecution(f.execution, 0)).toBe(!unknownActive)
    expect((await f.journal.jobNativeOwner(f.execution.operationId))?.nonEntryConfirmed).toBe(!unknownActive)
  })
  it('admits a control command when another approved tool directory leads the captured PATH', async () => {
    const f = await fixture()
    const approvedPath = '/private/approved-node/bin:/usr/bin:/bin'
    f.qualified.candidate.controllerEnvironment.PATH = approvedPath
    vi.spyOn(qualification, 'assertJobRuntimeEntryContext').mockResolvedValue(undefined)
    await f.journal.jobReserveEntry(f.execution.operationId)
    if (typeof f.ports.supervisor !== 'function') throw new Error('Supervisor factory unavailable')
    const supervisor = await f.ports.supervisor(f.execution)
    await expect(supervisor.reconcile(f.execution)).rejects.toThrow('No OCI entry expected')
    expect(f.registry.reserveLaunch).toHaveBeenCalledOnce()
    expect(f.qualified.candidate.controllerEnvironment.PATH).toBe(approvedPath)
  })
  it('retains the full original execution and independently checks both real mount directories', async () => {
    const f = await fixture(), original = structuredClone(f.execution)
    expect(await f.check()).toBe(f.source)
    expect(f.verify).toHaveBeenCalledWith(original, f.source)
    f.execution.owner.epoch = '2'
    await expect(f.check()).resolves.toBe(f.source)
    expect(f.verify.mock.calls.at(-1)?.[0]).toEqual(original)
  })
  it.each(['missing', 'old'] as const)('rejects %s layout before OCI entry', async kind => {
    const f = await fixture()
    if (kind === 'missing') delete f.source.gitMounts
    else Object.assign(f.mounts, { layout: 'source-inputs-v0' })
    await f.host.deliver(f.intent, f.execution); await f.host.drain()
    const status = await f.journal.jobStatus(f.intent.operationId)
    expect(status.status === 'known' && status.receipt.terminal?.outcome).toBe('preparation_failed')
    expect(status.status === 'known' && status.receipt.entryAttempted).toBe(false)
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled(); expect(f.inputs.prepare).not.toHaveBeenCalled()
  })
  it.each(['workspaceId', 'executionId', 'attemptId', 'operationId', 'specDigest', 'bindingHash', 'materializationId', 'materializationDigest'] as const)('rejects substituted %s', async field => {
    const f = await fixture(); f.mounts[field] = 'foreign'
    await expect(f.check()).rejects.toThrow('Original qualified Job Git/scheduler mounts')
    expect(f.verify).not.toHaveBeenCalled()
  })
  it.each(['grantId', 'epoch'] as const)('rejects substituted owner %s', async field => {
    const f = await fixture(); f.mounts.owner[field] = 'foreign'
    await expect(f.check()).rejects.toThrow('Original qualified Job Git/scheduler mounts')
  })
  it('propagates the read-only leaf rejection', async () => {
    const f = await fixture(); f.verify.mockRejectedValue(new Error('Retained Git receipt changed'))
    await expect(f.check()).rejects.toThrow('Retained Git receipt changed')
  })
  it.each(['git', 'scheduler'] as const)('rejects replaced %s inode', async mount => {
    const f = await fixture(), path = f.mounts[mount].directory
    await rename(path, `${path}.original`); await mkdir(path, { mode: 0o700 })
    await expect(f.check()).rejects.toThrow('qualified filesystem or identity')
  })
  it.each(['git', 'scheduler'] as const)('rejects symlinked %s directory', async mount => {
    const f = await fixture(), path = f.mounts[mount].directory
    await rename(path, `${path}.original`); await symlink(`${path}.original`, path)
    await expect(f.check()).rejects.toThrow()
  })
  it.each(['device', 'mountId'] as const)('rejects a different qualified %s', async field => {
    const f = await fixture({ [field]: '0' })
    await expect(f.check()).rejects.toThrow('qualified filesystem or identity')
  })
  it('rejects ambiguous original admissions without choosing a replacement execution', async () => {
    const f = await fixture(), execution = structuredClone(f.execution); execution.operationId = 'second-operation'
    const supervisor = f.ports.supervisor as (execution: typeof f.execution) => Promise<unknown>
    await supervisor(execution)
    await expect(f.check()).rejects.toThrow('Unique original installed Job admission')
  })
  it.each(['git', 'scheduler'] as const)('rejects a foreign %s filesystem despite a passing leaf double', async mount => {
    const f = await fixture()
    const observedFilesystem = f.mounts[mount].filesystem
    f.mounts[mount].filesystem = { ...observedFilesystem, inode: '0' }
    await expect(f.check()).rejects.toThrow('qualified filesystem or identity')
    expect(await filesystem(f.mounts[mount].directory)).toEqual(observedFilesystem)
  })
  it.each([
    ['git', 'device'], ['git', 'mountId'], ['scheduler', 'device'], ['scheduler', 'mountId'],
  ] as const)('independently rejects a nested %s %s', async (mount, field) => {
    const f = await fixture(), readIdentity = privateFilesystem.identity
    vi.spyOn(privateFilesystem, 'identity').mockImplementation(async handle => {
      const observed = await readIdentity(handle)
      return await realpath(`/proc/self/fd/${handle.fd}`) === f.mounts[mount].directory ? { ...observed, [field]: '0' } : observed
    })
    await expect(f.check()).rejects.toThrow('qualified filesystem or identity')
  })
  it('rechecks the original journal owner after asynchronous leaf verification', async () => {
    const f = await fixture()
    f.verify.mockImplementation(async () => { await f.journal.jobControl({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop',
      operationId: f.execution.operationId, attemptId: f.execution.attemptId, executionId: f.execution.id,
      bindingHash: f.execution.acceptedSpec.bindingHash, subject: f.intent.subject, owner: f.execution.owner, action: { kind: 'stop' } }) })
    await expect(f.check()).rejects.toThrow('Original Job source owner changed')
  })
  it('checks cancellation after asynchronous source verification', async () => {
    const f = await fixture(), controller = new AbortController()
    f.verify.mockImplementation(async () => { controller.abort(new Error('Cancelled original preparation')) })
    await expect(f.check(controller.signal)).rejects.toThrow('Cancelled original preparation')
  })
  it('rejects missing original admission when protected runtime inspection fails', async () => {
    const f = await fixture(); f.inspect.mockRejectedValue(new Error('Old layout'))
    const other = structuredClone(f.execution); other.operationId = 'other'; other.acceptedSpec.specDigest = 'f'.repeat(64)
    await (f.ports.supervisor as (execution: typeof other) => Promise<unknown>)(other)
    await expect(f.ports.source.verify(other.acceptedSpec, new AbortController().signal)).rejects.toThrow('original installed Job admission')
  })
})


describe('fresh authorization of generated Podman create commands', () => {
  it.each(['cancelled', 'expired', 'revoked', 'cancelled-during-inspection'] as const)(
    'denies %s before native container creation', async reason => {
      const f = await fixture()
      const spec = f.execution.acceptedSpec
      const result = f.qualified.result
      if (!result || result.outcome !== 'qualified' || result.measurement.schemaVersion !== 1) {
        throw new Error('Build runtime fixture required')
      }
      const argv = podmanIsolationCreateArgv({ identity: 'original-job',
        sourceRoot: f.source.privateRepositoryRoot, runtimeRoot: spec.target.destination.managedRuntimeRoot,
        cwd: spec.target.destination.canonicalCwd, argv: spec.argv, profile: result.measurement.runtime,
        spoolBytes: spec.policy.maxWorkerSpoolBytes, labels: {}, inputRoot: join(f.source.privateRepositoryRoot, '.graphql-job-inputs'),
        gitDirectory: f.mounts.git.directory, schedulerDirectory: f.mounts.scheduler.directory })
      const cancel = () => f.journal.jobControl({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop-before-create',
        operationId: f.execution.operationId, executionId: f.execution.id, attemptId: f.execution.attemptId,
        subject: f.intent.subject, bindingHash: f.intent.bindingHash, owner: f.execution.owner, action: { kind: 'stop' } })
      if (reason === 'cancelled') await cancel()
      const authorize = vi.fn(async () => { if (reason === 'revoked') throw new Error('Current grant revoked') })
      const inspect = vi.fn(async () => { if (reason === 'cancelled-during-inspection') await cancel() })
      const pending = authorizeJobContainerEntry({ argv, execution: f.execution,
        measurementExpiresAt: reason === 'expired' ? new Date(0).toISOString() : new Date(Date.now() + 60000).toISOString(),
        readStatus: () => f.journal.jobStatus(f.execution.operationId), authorize, inspect,
        memoryHeadroom: async () => ({ running: 0, availableBytes: 32 * 2 ** 30 }) })
      await expect(pending).rejects.toThrow(reason === 'expired' ? 'expired' : reason === 'revoked' ? 'revoked' : 'fenced')
      if (reason === 'cancelled' || reason === 'expired') expect(authorize).not.toHaveBeenCalled()
      if (reason === 'cancelled-during-inspection') expect(inspect).toHaveBeenCalledOnce()
    })
})
