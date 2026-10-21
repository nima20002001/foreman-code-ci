import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentFilePublishInput } from '@foreman-code/contracts/files'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import type { TransferContext, TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { workflowArtifactTransferManifestDigest } from '@foreman-code/contracts/workflow-artifact-transfer-node'
import { fileToolFixture } from '../../../../test/support/fileTools.js'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { TemporaryFileService } from '../../files/service.js'
import { FileByteStorage } from '../../files/storage.js'
import { DistributedArtifactPublicationService, type AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import type { DistributedPublicationLink } from '../../files/distributed/publicationLedger.js'
import { WorkerNativeOutputRegistry } from './workerNativeOutputRegistry.js'
import { WorkerNativeArtifactSender, type WorkerNativeArtifactApplication } from './workerNativeArtifactSender.js'
import { createInstalledNativeOutputStorage, createNativeOutputBudgetLedger,
  type NativeOutputBudgetLedger } from './installedNativeOutputStorage.js'

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// Authority and native protection are fixture ports. Shared-budget scenarios use
// the installed ledger; registry, sender, receiver and canonical storage use real bytes.
async function fixture(body = Buffer.from('# tool-created workflow output\n'), chunkBytes = 4,
  sharedBudget?: { rootDirectory: string; context: TransferContext }) {
  // Avoid the scheduler's group-writable TMPDIR ancestors. This actual Linux
  // sticky-/tmp child is owned 0700 and still uses the full root qualifier.
  const f = await fileToolFixture(), root = await mkdtemp('/tmp/worker-native-sender-test-')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  // Main canonical storage deliberately excludes /tmp; keep its real byte store
  // in a separate owned directory, rather than weakening that storage boundary.
  const canonicalRoot = await mkdtemp(join(process.cwd(), '.worker-native-canonical-test-'))
  cleanups.push(() => rm(canonicalRoot, { recursive: true, force: true }))
  if (f.scope.chat.kind !== 'agent') throw new Error('fixture')
  f.scope.chat.runId = randomUUID(); f.scope.chat.executionId = randomUUID()
  const token = await f.issue()
  const context: TransferContext = sharedBudget?.context ?? { mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const rootBinding = { rootId: randomUUID(), rootBindingRevision: 1 }
  const intent: DispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: context.mainId, runId: f.scope.chat.runId,
    nodeId: 'producer', executionId: f.scope.chat.executionId, occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: randomUUID(), operationId: randomUUID(), bindingHash: hash('accepted original placement'), inputDigest: `sha256:${hash('input')}`,
    owner: { grantId: 'unit-original-grant', epoch: '1' } }
  const placement: AcceptedNodePlacement = { schemaVersion: 1, mainId: intent.mainId, runId: intent.runId, nodeId: intent.nodeId,
    hostRef: { kind: 'device', mainId: context.mainId, deviceId: context.deviceId },
    registration: { workerInstallationId: context.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    mainInstallationId: 'main-unit-installation', destination: { canonicalProjectRoot: root, canonicalCwd: root, managedRuntimeRoot: root,
      directoryIdentityHash: hash('unit-root'), rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'unit-attestation', attestationHash: hash('unit-attestation') },
    source: { revisionId: 'source', manifestDigest: hash('source'), materializationId: 'materialization', materializationDigest: hash('materialization') },
    payload: { kind: 'agent', agentId: f.scope.chat.agentId, agentConfigurationVersionId: 'saved-configuration', driverId: 'driver',
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'installation', installationFingerprint: 'fingerprint',
      runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [], artifactOutputs: { version: 1, outputKeys: ['report'] } },
    bindingHash: intent.bindingHash }
  const accepted: AcceptedArtifactPublication = { context: f.context, transferContext: context,
    attempt: { workspaceId: f.scope.chat.workspaceId, workflowId: f.scope.chat.workflowId, runId: intent.runId, nodeId: intent.nodeId,
      executionId: intent.executionId, attemptId: intent.attemptId, placementHash: intent.bindingHash } }
  const authority = { authorize: vi.fn(async () => f.sessions.authenticate(token, 'files.publish_result')),
    assertSourceLive: vi.fn(async () => {}) }
  const receiver = new ResumableByteTransferService(join(root, 'receiver'), { authorize: vi.fn(async () => {}) })
  cleanups.push(() => receiver.close())
  const files = new TemporaryFileService(f.repository, new FileByteStorage(canonicalRoot, MAX_FILE_BYTES),
    { resolve: async () => f.scope }, undefined, f.clock)
  const links = new Map<string, DistributedPublicationLink>()
  const publisher = new DistributedArtifactPublicationService(files, { read: async (_owner, id) => links.get(id),
    linkPublication: async link => {
      const prior = links.get(link.requestId)
      if (prior && prior.publicationInputHash !== link.publicationInputHash) throw new Error('Conflicting canonical publication')
      if (!prior) links.set(link.requestId, structuredClone(link))
    } }, receiver, authority, f.clock)
  const admissions = new Map<string, TransferIntent>()
  const main: WorkerNativeArtifactApplication = {
    admit: vi.fn(async input => {
      await authority.authorize()
      const prior = admissions.get(input.commandId)
      if (prior) return structuredClone(prior)
      const transfer: TransferIntent = { version: 1, ...context, ...rootBinding, transferId: randomUUID(), operationId: intent.operationId,
        executionId: intent.executionId, attemptId: intent.attemptId, placementHash: intent.bindingHash, direction: 'to-main', byteClass: 'artifact',
        sha256: input.sha256, byteSize: input.byteSize, manifestDigest: workflowArtifactTransferManifestDigest(input),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), chunkBytes }
      admissions.set(input.commandId, transfer); return structuredClone(transfer)
    }),
    publish: vi.fn(async input => publisher.publishAccepted(accepted, input.transferId, input.publication, 'mcp')),
  }
  const callback = { assertCurrent: vi.fn(async () => {}) }, call = { assertCurrent: vi.fn(async () => {}) }, protectedStorage = vi.fn(async () => {})
  const limits = { maxDiskBytes: 2 * MAX_FILE_BYTES, maxSnapshotBytes: 2 * MAX_FILE_BYTES,
    maxCommandRecords: 2 * BYTE_TRANSFER_POLICY.maxRecords }
  const nativeTurnId = f.context.turnId
  if (!nativeTurnId) throw new Error('Fixture requires a native turn')
  const owner = { intent, binding: { ...context, connectionGeneration: 1 },
    session: { harness: 'codex' as const, providerVersion: 'codex-cli 0.154.0', nativeSessionId: f.context.nativeSessionId },
    nativeTurnId, runtimeGeneration: 1 }
  let budget: NativeOutputBudgetLedger | undefined
  if (sharedBudget) {
    await mkdir(sharedBudget.rootDirectory, { recursive: true, mode: 0o700 })
    budget = await createNativeOutputBudgetLedger({ rootDirectory: sharedBudget.rootDirectory,
      installation: { mainId: context.mainId, deviceId: context.deviceId, workerInstallationId: context.workerInstallationId },
      limits, initializeNewStore: true })
  }
  const storage = budget ? await createInstalledNativeOutputStorage({ rootDirectory: root, owner, limits, budget,
    assertCurrent: callback.assertCurrent,
    protection: { assertProtected: protectedStorage, assertQuiescent: async () => {} } })
    : { rootDirectory: root, assertProtected: protectedStorage,
      reserve: async () => ({ assertCurrent: async () => {}, release: async () => {} }) }
  // Existing private root is a test stand-in. No native process is launched or
  // claimed to be fenced by this permissive qualification callback.
  const registry = await WorkerNativeOutputRegistry.open({ configuration: { harness: 'codex', model: 'unit-only', reasoningEffort: 'low',
    sandbox: 'workspace-write', serviceTier: 'standard' }, scope: f.scope, callback, authority: { assertCurrent: async () => { await authority.authorize() } },
    storage,
    publisher: { publish: (input, originalCall, signal) => sender.publish(input, originalCall, signal) } })
  cleanups.push(() => registry.withdraw())
  const connection = { current: vi.fn(async () => context), retryable: (error: unknown) => error instanceof Error && error.message === 'carrier lost' }
  const sender = new WorkerNativeArtifactSender({ intent, placement, root: rootBinding }, registry, main, receiver, connection)
  const dispatch = (command: Parameters<WorkerNativeOutputRegistry['dispatch']>[0]) => registry.dispatch(command, call)
  const created = await dispatch({ operation: 'create', commandId: randomUUID(), filename: 'result.md', mediaType: 'text/markdown' })
  if (created.operation !== 'create') throw new Error('fixture')
  const artifactId = created.artifactId
  for (let offset = 0; offset < body.length; offset += 64 * 1024) await dispatch({ operation: 'append', commandId: randomUUID(),
    artifactId, offset, contentBase64: body.subarray(offset, offset + 64 * 1024).toString('base64') })
  await dispatch({ operation: 'seal', commandId: randomUUID(), artifactId })
  const descriptor = { commandId: randomUUID(), artifactId, filename: 'result.md', mediaType: 'text/markdown' as const }
  const publication: AgentFilePublishInput = { ...descriptor, scope: f.scope }
  const publish = () => dispatch({ operation: 'publish', publication: descriptor })
  return { f, root, intent, placement, rootBinding, context, body, registry, callback, call, protectedStorage, sender, main, receiver, connection,
    files, authority, publication, publish, admissions, links, budget, owner, limits }
}

describe('original worker-native artifact sender', () => {
  it('publishes simultaneous declared-output turns and releases the shared installation budget', async () => {
    const rootDirectory = await mkdtemp('/tmp/concurrent-native-output-budget-')
    cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }))
    const context: TransferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
    const sharedBudget = { rootDirectory, context }
    const turns = await Promise.all([
      fixture(Buffer.from('# first declared report\n'), 64 * 1024, sharedBudget),
      fixture(Buffer.from('# second declared report\n'), 64 * 1024, sharedBudget),
    ])
    const replies = await Promise.all(turns.map(turn => turn.publish()))
    await Promise.all(turns.map(async (turn, index) => {
      const reply = replies[index]!
      if (reply.operation !== 'publish') throw new Error('Expected publication')
      expect(reply.result.value.revision).toMatchObject({ sha256: hash(turn.body), byteSize: turn.body.length })
      const downloaded = await turn.files.download(turn.f.principal,
        { kind: 'agent', workspaceId: 'workspace-a', conversationId: 'conversation-a' },
        { fileId: reply.result.value.file.fileId, revisionId: reply.result.value.revision.revisionId })
      const chunks: Buffer[] = []
      for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(turn.body)
    }))
    const first = turns[0]!
    const recovered = await createNativeOutputBudgetLedger({ rootDirectory,
      installation: { mainId: context.mainId, deviceId: context.deviceId, workerInstallationId: context.workerInstallationId },
      limits: first.limits })
    const extra = { owner: first.owner, limits: first.limits, artifactId: randomUUID(),
      requested: { maxDiskBytes: 1, maxSnapshotBytes: 1, maxCommandRecords: 1 } }
    await expect(recovered.reserve(extra)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_STORAGE_UNAVAILABLE' })
    await Promise.all(turns.map(turn => turn.registry.withdraw()))
    const reclaimed = await recovered.reserve({ ...extra, artifactId: randomUUID(), requested: first.limits })
    await reclaimed.assertCurrent()
    await reclaimed.release()
    expect(turns.map(turn => turn.links.size)).toEqual([1, 1])
  }, 60_000)

  it('transfers real tool-created bytes, verifies receipt and publishes exact canonical pins', async () => {
    const t = await fixture(), reply = await t.publish()
    if (reply.operation !== 'publish') throw new Error('fixture')
    const original = reply.result
    expect(original.value.revision).toMatchObject({ sha256: hash(t.body), byteSize: t.body.length, filename: 'result.md', origin: 'agent_output' })
    const transfer = t.admissions.get(t.publication.commandId)!
    const receipt = await t.receiver.resolveVerifiedReceipt(transfer.transferId, t.context)
    expect(receipt.sha256).toBe(hash(t.body)); expect(receipt.intent).toEqual(transfer)
    const downloaded = await t.files.download(t.f.principal, { kind: 'agent', workspaceId: 'workspace-a', conversationId: 'conversation-a' },
      { fileId: original.value.file.fileId, revisionId: original.value.revision.revisionId })
    const chunks: Buffer[] = []
    for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(t.body)
    expect(await t.publish()).toEqual(reply)
    expect(t.main.publish).toHaveBeenCalledTimes(1); expect(t.links.size).toBe(1)
  })
  it('accepts actual maximum append chunks and transfers a multi-chunk frozen artifact', async () => {
    const t = await fixture(Buffer.from(`# ${'a'.repeat(64 * 1024)}\n`), 64 * 1024)
    const append = vi.spyOn(t.receiver, 'append'), reply = await t.publish()
    expect(reply.operation).toBe('publish')
    expect(append.mock.calls.map(call => call[2].bytes.byteLength)).toEqual([64 * 1024, 3])
  })
  it('resumes real receiver bytes after lost chunk/final acknowledgments and keeps original command', async () => {
    const t = await fixture(), append = t.receiver.append.bind(t.receiver), finish = t.receiver.finish.bind(t.receiver)
    vi.spyOn(t.receiver, 'append').mockImplementationOnce(async (...args) => { await append(...args); throw new Error('carrier lost') })
    vi.spyOn(t.receiver, 'finish').mockImplementationOnce(async (...args) => { await finish(...args); throw new Error('carrier lost') })
    t.connection.current.mockResolvedValue({ ...t.context, connectionEpoch: randomUUID() })
    expect((await t.publish()).operation).toBe('publish')
    expect(t.main.admit).toHaveBeenCalledWith({ commandId: t.publication.commandId, sha256: hash(t.body), byteSize: t.body.length }, expect.any(AbortSignal))
    expect(t.links.size).toBe(1)
  })
  it('replays the same canonical allocation after a lost publication reply', async () => {
    const t = await fixture(), publish = vi.mocked(t.main.publish).getMockImplementation()!
    vi.mocked(t.main.publish).mockImplementationOnce(async (...args) => { await publish(...args); throw new Error('publication ACK lost') })
    await expect(t.publish()).rejects.toThrow('publication ACK lost')
    expect(t.links.size).toBe(1)
    const first = [...t.links.values()][0]!
    const reply = await t.publish()
    if (reply.operation !== 'publish') throw new Error('fixture')
    expect(reply.result.value.revision.revisionId).toBe(first.ref.revisionId)
    expect(reply.result.replayed).toBe(true); expect(t.admissions.size).toBe(1)
  })
  it.each(['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'operationId', 'executionId',
    'attemptId', 'placementHash', 'rootId', 'rootBindingRevision', 'direction', 'byteClass', 'sha256', 'byteSize', 'manifestDigest'] as const)('rejects a foreign admitted %s before starting transfer', async field => {
    const t = await fixture(), admit = vi.mocked(t.main.admit).getMockImplementation()!
    vi.mocked(t.main.admit).mockImplementationOnce(async (...args) => {
      const transfer = await admit(...args)
      return { ...transfer, [field]: field === 'direction' ? 'to-worker' : field === 'byteClass' ? 'source'
        : ['keyRevision', 'authorizationRevision', 'rootBindingRevision', 'byteSize'].includes(field) ? 2
          : ['placementHash', 'sha256', 'manifestDigest'].includes(field) ? hash('foreign') : randomUUID() }
    })
    const start = vi.spyOn(t.receiver, 'start')
    await expect(t.publish()).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    expect(start).not.toHaveBeenCalled(); expect(t.main.publish).not.toHaveBeenCalled()
  })
  it('denies current Main write authority without upload or canonical publication', async () => {
    const t = await fixture(), start = vi.spyOn(t.receiver, 'start')
    t.f.denyWrites()
    await expect(t.publish()).rejects.toThrow()
    expect(start).not.toHaveBeenCalled(); expect(t.links.size).toBe(0)
  })
  it('never publishes after an invalid final receipt', async () => {
    const t = await fixture(), finish = t.receiver.finish.bind(t.receiver)
    vi.spyOn(t.receiver, 'finish').mockImplementationOnce(async (...args) => ({ ...await finish(...args), sha256: hash('foreign') }))
    await expect(t.publish()).rejects.toThrow('receipt identity mismatch')
    expect(t.main.publish).not.toHaveBeenCalled(); expect(t.links.size).toBe(0)
  })
  it.each(['hash', 'scope', 'metadata'] as const)('rejects mismatched canonical %s readback without a success reply', async kind => {
    const t = await fixture(), publish = vi.mocked(t.main.publish).getMockImplementation()!
    vi.mocked(t.main.publish).mockImplementationOnce(async (...args) => {
      const result = structuredClone(await publish(...args))
      if (kind === 'hash') result.value.revision = { ...result.value.revision, sha256: hash('foreign') }
      if (kind === 'scope') result.value.file = { ...result.value.file, scope: t.f.foreign }
      if (kind === 'metadata') result.value.revision = { ...result.value.revision, filename: 'foreign.md' }
      return result
    })
    await expect(t.publish()).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    expect(t.links.size).toBe(1) // Canonical fact exists, but no acceptance is fabricated.
  })
  it('rechecks original callback after real receiver completion before Main publication', async () => {
    const t = await fixture(), finish = t.receiver.finish.bind(t.receiver)
    vi.spyOn(t.receiver, 'finish').mockImplementationOnce(async (...args) => {
      const receipt = await finish(...args)
      t.callback.assertCurrent.mockRejectedValue(new Error('original turn withdrawn')); return receipt
    })
    await expect(t.publish()).rejects.toThrow('original turn withdrawn')
    expect(t.main.publish).not.toHaveBeenCalled()
  })
  it('checks this publication callback after Main admission before transfer effects', async () => {
    const t = await fixture(), admit = vi.mocked(t.main.admit).getMockImplementation()!
    vi.mocked(t.main.admit).mockImplementationOnce(async (...args) => {
      const transfer = await admit(...args)
      t.call.assertCurrent.mockRejectedValue(new Error('publication callback withdrawn'))
      return transfer
    })
    const start = vi.spyOn(t.receiver, 'start')
    await expect(t.publish()).rejects.toThrow('publication callback withdrawn')
    expect(start).not.toHaveBeenCalled(); expect(t.main.publish).not.toHaveBeenCalled()
  })
  it('checks this original callback after carrier connection awaits before start', async () => {
    const t = await fixture(), start = vi.spyOn(t.receiver, 'start')
    t.connection.current.mockImplementationOnce(async () => {
      t.call.assertCurrent.mockRejectedValue(new Error('original carrier callback withdrawn'))
      return t.context
    })
    await expect(t.publish()).rejects.toThrow('original carrier callback withdrawn')
    expect(start).not.toHaveBeenCalled(); expect(t.main.publish).not.toHaveBeenCalled()
  })
  it('rejects changed frozen source before admission', async () => {
    const t = await fixture()
    const sender = new WorkerNativeArtifactSender({ intent: t.intent, placement: t.placement, root: t.rootBinding }, {
      sealed: async () => ({ sha256: hash(t.body), byteSize: t.body.length, assertCurrent: async () => {},
        read: async () => Buffer.alloc(t.body.length) }),
    }, t.main, t.receiver, t.connection)
    await expect(sender.publish(t.publication, t.call)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    expect(t.main.admit).not.toHaveBeenCalled()
  })
  it('rejects foreign run scope and cancellation before opening source', async () => {
    const t = await fixture(), source = { sealed: vi.fn(async () => { throw new Error('must not open') }) }
    const sender = new WorkerNativeArtifactSender({ intent: t.intent, placement: t.placement, root: t.rootBinding }, source, t.main, t.receiver, t.connection)
    await expect(sender.publish({ ...t.publication, scope: t.f.foreign }, t.call)).rejects.toThrow()
    const abort = new AbortController(); abort.abort(new Error('cancelled'))
    await expect(sender.publish(t.publication, t.call, abort.signal)).rejects.toThrow('cancelled')
    expect(source.sealed).not.toHaveBeenCalled()
  })
})
