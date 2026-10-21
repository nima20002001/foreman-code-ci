import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcceptedNodePlacement, DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { TemporaryFileScope } from '@foreman-code/contracts/files'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import type { CodexNativeOutputCallback, CodexNativeOutputTurnPin,
  CodexNativeOutputQualificationInput } from '../../harnesses/codexNativeOutput.js'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { createInstalledNativeOutputs, type InstalledNativeOutputProviders } from './installedNativeOutput.js'
import { createInstalledWorkflowNativeOutputProviders } from './installedWorkflowNativeOutputs.js'
import { createNativeOutputBudgetLedger } from './installedNativeOutputStorage.js'
import { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import { runCommand } from '../../harnesses/process.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const directory = await mkdtemp('/tmp/installed-native-output-'); cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'private'); await mkdir(root, { mode: 0o700 })
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const intent: DispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: binding.mainId, runId: 'run', nodeId: 'node',
    executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt',
    operationId: 'operation', bindingHash: 'a'.repeat(64), inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } }
  const placement: AcceptedNodePlacement = { schemaVersion: 1, mainId: binding.mainId, runId: intent.runId, nodeId: intent.nodeId,
    hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
    registration: { workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    mainInstallationId: 'installation', destination: { canonicalProjectRoot: '/workspace', canonicalCwd: '/workspace',
      managedRuntimeRoot: '/runtime', directoryIdentityHash: 'c'.repeat(64), rootPolicyId: 'policy', rootPolicyRevision: '1',
      locationRevision: '1', attestationId: 'attestation', attestationHash: 'd'.repeat(64) },
    source: { revisionId: 'source', manifestDigest: 'e'.repeat(64), materializationId: 'materialization', materializationDigest: 'f'.repeat(64) },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'driver', driverRevision: '1',
      instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'installation', installationFingerprint: 'fingerprint',
      runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [], artifactOutputs: { version: 1, outputKeys: ['report'] } },
    bindingHash: intent.bindingHash }
  const scope: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation', workspaceId: 'workspace',
    workflowId: 'workflow', agentId: 'agent', runId: intent.runId, executionId: intent.executionId } }
  const qualification: CodexNativeOutputQualificationInput = {
    configuration: { harness: 'codex', model: 'unit-only', reasoningEffort: 'low', sandbox: 'workspace-write', serviceTier: 'standard' },
    binary: '/unit/codex', binaryIdentity: 'unit-binary', providerVersion: 'codex-cli 0.154.0', schemaIdentity: 'unit-schema',
    expectedSandbox: { cwd: '/workspace', writableRoots: ['/workspace'], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true, tmpdir: undefined },
  }
  const pin: CodexNativeOutputTurnPin = { session: { harness: 'codex', providerVersion: qualification.providerVersion, nativeSessionId: 'native' },
    connectionId: 'connection', runtimeGeneration: 1, nativeTurnId: 'turn', assertCurrent: vi.fn(() => {}) }
  const release = vi.fn(async () => {}), reserve = vi.fn(async () => ({ assertCurrent: vi.fn(async () => {}), release }))
  const receiver = new ResumableByteTransferService(join(directory, 'receiver'), { authorize: async () => {} })
  cleanups.push(() => receiver.close())
  // Fixture authority/protection/budget ports only. Real anchored store and W09
  // registry are exercised; no native or authenticated Main proof is produced.
  const ports: InstalledNativeOutputProviders = {
    assertQualified: vi.fn(async () => {}), assertCurrent: vi.fn(async () => {}), authorize: vi.fn(async () => scope),
    storage: (_prepared, original) => ({ rootDirectory: root,
      owner: { intent, binding, session: original.session, nativeTurnId: original.nativeTurnId, runtimeGeneration: original.runtimeGeneration },
      limits: { maxDiskBytes: MAX_FILE_BYTES, maxSnapshotBytes: MAX_FILE_BYTES, maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords },
      budget: { reserve }, protection: { assertProtected: async () => {}, assertQuiescent: async () => {} }, assertCurrent: async () => {} }),
    artifacts: { binding: { intent, placement, root: { rootId: randomUUID(), rootBindingRevision: 1 } }, receiver,
      main: { admit: async () => { throw new Error('No Main admission in composition fixture') },
        publish: async () => { throw new Error('No Main publication in composition fixture') } },
      connection: { current: async () => binding, retryable: () => false } },
  }
  const native = createInstalledNativeOutputs(ports), signal = new AbortController().signal
  const prepare = () => native.prepare({ ...qualification, session: pin.session, clientCorrelationId: 'correlation',
    connectionId: pin.connectionId, runtimeGeneration: pin.runtimeGeneration, effectiveSandbox: qualification.expectedSandbox }, signal)
  const callback = (check = () => {}) => ({ ...pin, rpcId: 'rpc', callId: randomUUID(), assertCurrent: check } satisfies CodexNativeOutputCallback)
  const command = () => ({ operation: 'create' as const, commandId: randomUUID(), filename: 'report.md', mediaType: 'text/markdown' as const })
  return { directory, root, binding, intent, placement, ports, scope, qualification, pin,
    release, reserve, native, signal, prepare, callback, command }
}

describe('installed native common composition, no native qualification', () => {
  it('retries installed ledger initialization after storage failure while retaining qualification checks', async () => {
    const f = await fixture()
    const stateDirectory = join(f.directory, 'installed')
    const budgetDirectory = join(stateDirectory, 'native-output-budget')
    await mkdir(budgetDirectory, { recursive: true, mode: 0o700 })
    const residue = join(budgetDirectory, 'unreconciled')
    await writeFile(residue, 'original storage residue', { mode: 0o600 })
    const filesystem = { device: '1', inode: '2', mountId: '3' }
    const materialization = SourceMaterializationRecordSchema.parse({
      receipt: { version: 1, materializationId: randomUUID(),
        binding: { version: 1, mainId: f.binding.mainId, deviceId: f.binding.deviceId,
          workerInstallationId: f.binding.workerInstallationId, workspaceId: 'workspace', rootId: randomUUID(),
          bindingRevision: 1, locationRevision: 1, canonicalPath: '/workspace', filesystem,
          accessMode: 'exclusive-write', snapshotId: randomUUID(), manifestDigest: 'e'.repeat(64) },
        placementHash: f.intent.bindingHash, executionId: f.intent.executionId, attemptId: f.intent.attemptId,
        keyRevision: 1, authorizationRevision: 1, verifiedManifestDigest: 'e'.repeat(64),
        verifiedEntries: 0, verifiedBytes: 0, verifiedAt: '2026-01-01T00:00:00.000Z', localTreeIdentity: filesystem },
      rootPolicyId: 'policy', rootPolicyRevision: '1', operationId: f.intent.operationId, reservationId: randomUUID(),
      sourceBindingHash: 'e'.repeat(64), finalDispatchBindingHash: f.intent.bindingHash, state: 'running',
    })
    // This test reaches the qualification boundary without claiming a protected native producer.
    const qualify = vi.fn(async () => { throw new Error('External native qualification boundary') })
    const providers = createInstalledWorkflowNativeOutputProviders({ stateDirectory,
      context: { intent: f.intent, placement: f.placement, binding: f.binding, materialization,
        applicationAccess: () => ({ kind: 'scoped-worker-mcp', token: 'unit-only', executionId: f.intent.executionId,
          agentId: 'agent', operationId: f.intent.operationId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash }),
        publicationCompleted: () => {}, assertCurrent: async (_pin, signal) => { signal?.throwIfAborted() } },
      registry: new NativeProcessRegistry(join(f.directory, 'processes')),
      qualification: { qualify, command: runCommand },
      captureRequest: () => ({ binding: f.binding, request: async () => ({ payload: {
        version: 1, mainId: f.binding.mainId, audience: 'worker', principalId: 'owner',
        executionId: f.intent.executionId, agentId: 'agent', operationId: f.intent.operationId,
        attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, expiresAt: '2099-01-01T00:00:00.000Z',
        agentConfigurationVersionId: 'configuration', outputOperations: ['create', 'append', 'seal', 'publish'],
      } }) }),
    })
    await expect(providers.assertQualified(f.qualification, f.signal))
      .rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_STORAGE_UNAVAILABLE' })
    expect(qualify).not.toHaveBeenCalled()
    await unlink(residue)
    await expect(providers.assertQualified(f.qualification, f.signal)).rejects.toThrow('External native qualification boundary')
    expect(qualify).toHaveBeenCalledTimes(1)
    const limits = { maxDiskBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
      maxSnapshotBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
      maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal }
    const recovered = await createNativeOutputBudgetLedger({ rootDirectory: budgetDirectory,
      installation: { mainId: f.binding.mainId, deviceId: f.binding.deviceId, workerInstallationId: f.binding.workerInstallationId },
      limits })
    const reservation = await recovered.reserve({ owner: { intent: f.intent, binding: f.binding,
      session: f.pin.session, nativeTurnId: f.pin.nativeTurnId, runtimeGeneration: f.pin.runtimeGeneration },
      artifactId: randomUUID(), limits, requested: { maxDiskBytes: 1, maxSnapshotBytes: 1, maxCommandRecords: 1 } })
    await reservation.assertCurrent()
    await reservation.release()
  })

  it('requires genuine provider qualification and opens nothing until durable activation', async () => {
    const f = await fixture()
    vi.mocked(f.ports.assertQualified).mockRejectedValueOnce(new Error('No actual qualification'))
    await expect(f.native.assertQualified(f.qualification, f.signal)).rejects.toThrow('No actual qualification')
    const bridge = await f.prepare(); cleanups.push(() => bridge.close())
    expect(await readdir(f.root)).toEqual([]); expect(f.reserve).not.toHaveBeenCalled()
    await expect(bridge.dispatch(f.command(), f.callback(), f.signal)).rejects.toThrow()
    await bridge.activate(f.pin, f.signal)
    expect(f.ports.authorize).not.toHaveBeenCalled()
    await expect(bridge.activate(f.pin, f.signal)).rejects.toThrow()
    const reply = await bridge.dispatch(f.command(), f.callback(), f.signal)
    expect(reply.operation).toBe('create'); expect(f.reserve).toHaveBeenCalledTimes(1)
  })
  it('denies a Main scope from another execution before opening the registry', async () => {
    const f = await fixture(), bridge = await f.prepare(); cleanups.push(() => bridge.close())
    if (f.scope.chat.kind !== 'agent') throw new Error('fixture')
    vi.mocked(f.ports.authorize).mockResolvedValue({ ...f.scope, chat: { ...f.scope.chat, executionId: 'foreign' } })
    await bridge.activate(f.pin, f.signal)
    await expect(bridge.dispatch(f.command(), f.callback(), f.signal)).rejects.toThrow()
    expect(f.reserve).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([])
  })
  it('carries each original callback through authority awaits without a latest-call slot', async () => {
    const f = await fixture(), bridge = await f.prepare(); cleanups.push(() => bridge.close())
    await bridge.activate(f.pin, f.signal)
    let active = true
    const withdrawn = f.callback(() => { if (!active) throw new Error('Original callback withdrawn') })
    vi.mocked(f.ports.authorize).mockImplementationOnce(async () => { active = false; return await f.ports.authorize(f.pin, 'create') })
    await expect(bridge.dispatch(f.command(), withdrawn, f.signal)).rejects.toThrow('Original callback withdrawn')
    expect(await readdir(f.root)).toEqual([])
    expect((await bridge.dispatch(f.command(), f.callback(), f.signal)).operation).toBe('create')
  })
  it('drains an in-flight first callback after withdrawal before completing close', async () => {
    const f = await fixture(), bridge = await f.prepare(); cleanups.push(() => bridge.close())
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(f.ports.authorize).mockImplementationOnce(async () => { entered(); await gate; return f.scope })
    await bridge.activate(f.pin, f.signal)
    const opening = bridge.dispatch(f.command(), f.callback(), f.signal)
    const rejected = expect(opening).rejects.toThrow()
    await started
    let closed = false
    const closing = bridge.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release(); await rejected; await closing
    expect(f.reserve).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([])
  })
  it('fences dispatch immediately and retries cleanup without releasing uncertain bytes', async () => {
    const f = await fixture(), bridge = await f.prepare(); cleanups.push(() => bridge.close())
    await bridge.activate(f.pin, f.signal)
    await bridge.dispatch(f.command(), f.callback(), f.signal)
    f.release.mockRejectedValueOnce(new Error('Original budget ledger unavailable'))
    await expect(bridge.close()).rejects.toThrow()
    await expect(bridge.dispatch(f.command(), f.callback(), f.signal)).rejects.toThrow()
    await bridge.close()
    expect(f.release).toHaveBeenCalledTimes(2); expect(await readdir(f.root)).toEqual([])
  })
})
