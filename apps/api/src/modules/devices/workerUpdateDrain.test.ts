import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceConnectionIdentitySchema, WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { workerConversationFixture } from '../conversations/workerFixtures.test-support.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { deferred, rejectableDeferred } from '../../../test/helpers/deferred.js'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'

// Native MCP files are exercised separately; domain fixtures must not touch the host user profile.
vi.mock('../harnesses/installedWorkerManagedMcp.js', () => ({
  createInstalledWorkerManagedMcp: () => ({ worker: {}, ensureReady: async () => {} }),
}))
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { qualifyApprovedRootAllowlist } from '../sources/rootAttestation.js'
import { ResumableByteTransferService } from '../byte-transfer/service.js'
import { transferContextForBinding } from '../byte-transfer/carrier.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { HostCiRunner } from '../ci-host/runner.js'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { NativeProcessRegistry, type NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { workerConversationProcessDigest } from '../conversations/workerNativeOwner.js'

it('waits for uncertain native conversation work without treating an idle open session as active update work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-update-journal-'))
  const store = await RemoteOperationJournal.open(join(directory, 'operations.json'), { initializeNewInstallation: true })
  try {
    const f = workerConversationFixture()
    await store.conversations.receive(f.binding, f.connection)
    await store.conversations.reserveCreation(f.binding, 'create', commandInputHash('create'))
    await store.conversations.bindSession(f.binding, f.session, f.nativeOwner)
    expect(await store.isRuntimeQuiescent()).toBe(false)
    expect(await store.isWorkerUpdateIdle()).toBe(true)
    await store.conversations.reserveTurn(f.binding, 'turn', commandInputHash('turn'))
    expect(await store.isWorkerUpdateIdle()).toBe(false)
    await store.conversations.submitted(f.binding, 'turn', { nativeTurnId: 'native-turn' })
    await store.conversations.finishTurn(f.binding, 'turn')
    expect(await store.isWorkerUpdateIdle()).toBe(false)
    await store.conversations.finishTurn(f.binding, 'turn', { outcome: 'succeeded' })
    expect(await store.isWorkerUpdateIdle()).toBe(true)
    const compact = await store.conversations.reserveCompact(f.binding, 'compact', commandInputHash('compact'))
    expect(await store.isWorkerUpdateIdle()).toBe(false)
    await store.conversations.compactProgress(f.binding, { ...compact.state, status: 'completed' })
    expect(await store.isWorkerUpdateIdle()).toBe(true)
    expect((await store.conversations.read(f.binding))?.turns[0]?.result).toEqual({ outcome: 'succeeded' })
    expect(await store.isRuntimeQuiescent()).toBe(false)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('mounts update admission draining even when no job or workflow runtime is configured', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'worker-update-domains-'))
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(),
    deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' })
  const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: pairing.workerInstallationId, bootId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const domains = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
    configuration: null, approvedRoots: async () => null, codexSuiteRevision: 'fixture',
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(), captureRequest: () => undefined }) })
  try {
    await domains.drainForUpdate()
    const extension = domains.extensions.find(extension => extension.namespace === 'harness-discovery-v1')!
    await expect(extension.handle!({}, { binding, signal: AbortSignal.timeout(1000) }))
      .rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    domains.resumeAfterUpdate()
  } finally {
    await domains.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

it('rejects Host CI and accepted rsync writer starts after drain while keeping controls available', async () => {
  const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-drain-controls-'))
  const project = join(stateDirectory, 'project')
  const stagingRoot = join(stateDirectory, 'staging')
  await mkdir(project, { mode: 0o700 })
  await mkdir(stagingRoot, { mode: 0o700 })
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(),
    deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' })
  const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: pairing.workerInstallationId, bootId: bootIdentity(), keyRevision: 1,
    authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const approved = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
    hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
    applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-write'] }],
    managedRuntimeRoot: stateDirectory })
  const intent: TransferIntent = { ...transferContextForBinding(binding), version: 1,
    transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(), attemptId: randomUUID(),
    placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-worker',
    byteClass: 'source', sha256: 'b'.repeat(64), byteSize: 8, manifestDigest: 'c'.repeat(64), chunkBytes: 8,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const accepted = { intent: vi.fn(async () => intent), authorize: vi.fn(async () => {}) }
  const receiver = new ResumableByteTransferService(join(stateDirectory, 'canonical'), accepted)
  const executable = await realpath(process.execPath)
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex')
  const domains = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
    configuration: null, approvedRoots: async () => approved, codexSuiteRevision: 'fixture',
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(), captureRequest: () => undefined }),
    rsync: { stagingRoot, accepted, receiver, binary: { executable, sha256 },
      resolveSource: async () => { throw new Error('No source reader selected') },
      acknowledged: async () => {}, quiescent: async () => {} } })
  const hostCi = vi.spyOn(HostCiRunner.prototype, 'handle')
  const frame = { binding, signal: AbortSignal.timeout(5000) }
  const ci = domains.extensions.find(extension => extension.namespace === 'ci-host-v1')!
  const rsync = domains.extensions.find(extension => extension.namespace === 'rsync-stage-v1')!
  const writer = (method: string) => ({ kind: 'rsync-stage-v1', method, transferId: intent.transferId })
  let finishPreparation!: () => void
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve })
  try {
    await rsync.handle!(writer('writer-prepare'), frame)
    await rsync.handle!(writer('writer-stop'), frame)
    accepted.intent.mockClear()
    hostCi.mockImplementationOnce(async () => {
      await preparation
      throw new Error('CI preparation finished')
    })
    const starting = ci.handle!({ operation: 'start', runId: randomUUID(), repository: 'example/project',
      commit: 'd'.repeat(40), suite: 'unit' }, frame)
    const preparationFinished = expect(starting).rejects.toThrow('CI preparation finished')
    let drained = false
    const draining = domains.drainForUpdate().then(() => { drained = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(drained).toBe(false)
    finishPreparation()
    await preparationFinished
    await draining
    hostCi.mockRejectedValue(new Error('Host CI handler reached'))
    await expect(ci.handle!({ operation: 'start', runId: randomUUID(), repository: 'example/project',
      commit: 'd'.repeat(40), suite: 'unit' }, frame)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    for (const method of ['writer-prepare', 'writer-activate', 'receiver-prepare']) {
      await expect(rsync.handle!(writer(method), frame)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    }
    expect(domains.rsyncOwnership!.inventory()).toEqual([intent])
    expect(accepted.intent).not.toHaveBeenCalled()
    await expect(ci.handle!({ operation: 'status' }, frame)).rejects.toThrow('Host CI handler reached')
    await expect(ci.handle!({ operation: 'cancel', runId: randomUUID() }, frame))
      .rejects.toThrow('Host CI handler reached')
    for (const method of ['writer-status', 'writer-stop']) {
      expect((await rsync.handle!(writer(method), frame)).payload).toEqual(writer(method))
    }
    domains.resumeAfterUpdate()
    expect((await rsync.handle!(writer('writer-prepare'), frame)).payload).toMatchObject({ method: 'writer-prepare' })
    await rsync.handle!(writer('writer-stop'), frame)
  } finally {
    finishPreparation()
    hostCi.mockRestore()
    await domains.close()
    await receiver.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }
})


const recoveryDirectories: string[] = []
afterEach(async () => {
  for (const directory of recoveryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it.each(['turn', 'compaction', 'closing', 'access-change'] as const)(
  'finishes an idle update with retained %s recovery state after original native closure', async pending => {
    const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-drain-recovery-'))
    recoveryDirectories.push(stateDirectory)
    const project = join(stateDirectory, 'project')
    await mkdir(project, { mode: 0o700 })
    const f = workerConversationFixture()
    const connection = { ...f.connection, bootId: bootIdentity() }
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1,
      mainId: connection.mainId, deviceId: connection.deviceId,
      workerInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
      credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' })
    const approved = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
      hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
      applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-write'] }],
      managedRuntimeRoot: stateDirectory })
    const launch: NativeLaunchObservation = {
      owner: `conversation:${f.binding.owner.conversationId}`, launchId: randomUUID(), bootId: connection.bootId,
      guardian: { pid: 200, startTicks: '2000' }, provider: { pid: 201, startTicks: '2001' },
      boundary: { kind: 'cgroup-v2', path: '/fixture/native-boundary', device: '1', inode: '2' },
      lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty',
    }
    const nativeOwner = { ...f.nativeOwner, processIdentityDigest: workerConversationProcessDigest(f.binding, launch) }
    const path = join(stateDirectory, 'workflow-operations.json')
    const journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true })
    let retained
    try {
      await journal.conversations.receive(f.binding, connection)
      await journal.conversations.reserveCreation(f.binding, 'create', commandInputHash('create'))
      await journal.conversations.bindSession(f.binding, f.session, nativeOwner)
      if (pending === 'turn') {
        await journal.conversations.reserveTurn(f.binding, 'turn', commandInputHash('turn'))
        await journal.conversations.submitted(f.binding, 'turn', { nativeTurnId: 'native-turn' })
        await journal.conversations.finishTurn(f.binding, 'turn')
      } else if (pending === 'compaction') {
        const compact = await journal.conversations.reserveCompact(f.binding, 'compact', commandInputHash('compact'))
        await journal.conversations.compactProgress(f.binding, { ...compact.state, status: 'uncertain' })
      } else if (pending === 'closing') {
        await journal.conversations.closeRequested(f.binding)
      } else {
        await journal.conversations.reserveApplicationAccess(f.binding,
          { ...f.binding, appMcpAccess: 'scoped' }, 'access', f.session)
      }
      retained = await journal.conversations.read(f.binding)
      expect(await journal.isWorkerUpdateIdle()).toBe(false)
    } finally { await journal.close() }
    const location = { path: join(stateDirectory, 'workflow-runtime.json'), ownerUid: process.getuid!() }
    await writeFile(location.path, JSON.stringify({ schemaVersion: 1, codexBinary: process.execPath,
      expectedVersion: 'codex-cli 0.162.0', payloadPaths: [], appMcpLauncher: '/installed/launcher.mjs',
    }), { mode: 0o600 })
    // The registry double supplies a qualified closure observation; no native process is launched.
    const snapshot = vi.spyOn(NativeProcessRegistry.prototype, 'snapshot')
      .mockReturnValue({ revision: 'fixture:1', launches: [] })
    const domains = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: connection.bootId,
      configuration: location, approvedRoots: async () => approved, codexSuiteRevision: 'fixture',
      connection: () => ({ currentBinding: () => connection, mainNow: () => Date.now(), captureRequest: () => undefined }) })
    let drained = false
    const draining = domains.drainForUpdate().then(() => { drained = true })
    void draining.catch(() => {
      // ignore: cleanup aborts the drain if the bounded completion assertion fails; success is asserted below.
    })
    try {
      const blockingSnapshots = [
        [],
        [{ ...launch, launchId: randomUUID() }],
        [launch, { ...launch, launchId: randomUUID(), lifecycle: 'closure-unconfirmed' as const,
          closureEvidence: undefined }],
      ]
      for (const launches of blockingSnapshots) {
        snapshot.mockReturnValue({ revision: 'fixture:1', launches })
        await new Promise(resolve => setTimeout(resolve, 150))
        expect(drained).toBe(false)
      }
      snapshot.mockReturnValue({ revision: 'fixture:2', launches: [launch] })
      await expect.poll(() => drained, { timeout: 2000 }).toBe(true)
      await expect(draining).resolves.toBeUndefined()
      const discovery = domains.extensions.find(extension => extension.namespace === 'harness-discovery-v1')!
      await expect(discovery.handle!({}, { binding: connection, signal: AbortSignal.timeout(1000) }))
        .rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    } finally {
      await domains.close()
      await Promise.allSettled([draining])
      snapshot.mockRestore()
    }
    const reopened = await RemoteOperationJournal.open(path)
    try {
      expect(await reopened.conversations.read(f.binding)).toEqual(retained)
      expect(await reopened.isWorkerUpdateIdle()).toBe(false)
    } finally {
      await reopened.close()
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })


it('finishes an update while Main source cleanup is pending and resumes admissions before that cleanup returns', async () => {
  const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-background-cleanup-'))
  const project = join(stateDirectory, 'project')
  await mkdir(project, { mode: 0o700 })
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(),
    deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' })
  const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: pairing.workerInstallationId, bootId: bootIdentity(), keyRevision: 1,
    authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const approved = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
    hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
    applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-write'] }],
    managedRuntimeRoot: stateDirectory })
  const requested = deferred<void>()
  const mainCleanup = rejectableDeferred<never>()
  const domains = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
    configuration: null, approvedRoots: async () => approved, codexSuiteRevision: 'fixture',
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(),
      captureRequest: () => ({ binding, request: async () => { requested.resolve(); return mainCleanup.promise } }) }) })
  const source = domains.extensions.find(extension => extension.namespace === 'source-operations-v1')!
  const discovery = domains.extensions.find(extension => extension.namespace === 'harness-discovery-v1')!
  const frame = { binding, signal: new AbortController().signal }
  const cleaning = source.handle!({ version: 1, operation: 'sources.reclaim-reservation',
    reservationId: randomUUID(), reclamationId: randomUUID() }, frame)
  const cleanupResult = expect(cleaning).rejects.toThrow('Main cleanup unavailable')
  await requested.promise
  let drained = false
  const draining = domains.drainForUpdate().then(() => { drained = true })
  try {
    await expect.poll(() => drained, { timeout: 2000 }).toBe(true)
    await draining
    await expect(discovery.handle!({}, frame)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    domains.resumeAfterUpdate()
    expect((await discovery.handle!({ operation: 'discover', refreshId: randomUUID() }, frame)).payload).toBeDefined()
    mainCleanup.reject(new Error('Main cleanup unavailable'))
    await cleanupResult
  } finally {
    mainCleanup.reject(new Error('Main cleanup unavailable'))
    await domains.close()
    await Promise.allSettled([cleaning, draining])
    await cleanupResult
    await rm(stateDirectory, { recursive: true, force: true })
  }
})


it('drains stopped source transfers before the idle deadline while retaining active transfers and native owners', async () => {
  const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-stopped-transfer-'))
  const project = join(stateDirectory, 'project')
  const stagingRoot = join(stateDirectory, 'staging')
  await mkdir(project, { mode: 0o700 })
  await mkdir(stagingRoot, { mode: 0o700 })
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(),
    deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' })
  const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: pairing.workerInstallationId, bootId: bootIdentity(), keyRevision: 1,
    authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const approved = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
    hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
    applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-write'] }],
    managedRuntimeRoot: stateDirectory })
  const intent: TransferIntent = { ...transferContextForBinding(binding), version: 1,
    transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(), attemptId: randomUUID(),
    placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-worker',
    byteClass: 'source', sha256: 'b'.repeat(64), byteSize: 8, manifestDigest: 'c'.repeat(64), chunkBytes: 8,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const journal = await RemoteOperationJournal.open(join(stateDirectory, 'workflow-operations.json'),
    { initializeNewInstallation: true })
  await journal.accept({ schemaVersion: 1, protocolVersion: 1, mainId: pairing.mainId,
    runId: 'run', nodeId: 'node', executionId: intent.executionId, attemptId: intent.attemptId,
    operationId: intent.operationId, occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    bindingHash: intent.placementHash, inputDigest: `sha256:${'d'.repeat(64)}`,
    owner: { grantId: 'grant', epoch: '1' } }, DeviceConnectionIdentitySchema.strip().parse(binding), randomUUID())
  const stopped = await journal.revokeFence(intent.operationId)
  await journal.close()
  const accepted = { intent: async () => intent, authorize: async () => {} }
  const receiver = new ResumableByteTransferService(join(stateDirectory, 'canonical'), accepted)
  await receiver.start(intent, transferContextForBinding(binding))
  const activeTransfer = { ...intent, transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID() }
  await receiver.start(activeTransfer, transferContextForBinding(binding))
  const executable = await realpath(process.execPath)
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex')
  const domains = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
    configuration: null, approvedRoots: async () => approved, codexSuiteRevision: 'fixture',
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(), captureRequest: () => undefined }),
    rsync: { stagingRoot, accepted, receiver, binary: { executable, sha256 },
      resolveSource: async () => { throw new Error('No source reader selected') },
      acknowledged: async () => {}, quiescent: async () => {} } })
  const registry = new NativeProcessRegistry(join(stateDirectory, 'workflow-native-processes'))
  const reserved = await registry.reserveLaunch(`execution:${intent.executionId}`)
  let drained = false
  const draining = domains.drainForUpdate().then(() => { drained = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(drained).toBe(false)
    await receiver.cancel(activeTransfer.transferId, transferContextForBinding(binding))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(drained).toBe(false)
    await registry.abandonReservedLaunch(reserved)
    await expect.poll(() => drained, { timeout: 2000 }).toBe(true)
    await draining
    expect(await receiver.inventory()).toContainEqual(intent)
    expect(await receiver.isRuntimeQuiescent()).toBe(false)
    domains.resumeAfterUpdate()
    await domains.close()
    const retained = await RemoteOperationJournal.open(join(stateDirectory, 'workflow-operations.json'))
    try {
      expect(await retained.status(intent.operationId)).toEqual({ status: 'known', receipt: stopped })
    } finally { await retained.close() }
  } finally {
    await domains.close()
    await Promise.allSettled([draining])
    await journal.close()
    await receiver.close()
    registry.closeRetention()
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
