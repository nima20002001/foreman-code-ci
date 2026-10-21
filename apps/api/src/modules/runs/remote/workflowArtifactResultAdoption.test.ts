import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import type { VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { WorkflowVersionV3Schema, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import { fileToolFixture } from '../../../../test/support/fileTools.js'
import { DomainError } from '../../errors.js'
import { TemporaryFileService } from '../../files/service.js'
import { FileByteStorage } from '../../files/storage.js'
import { CanonicalNativeArtifactResults } from '../../files/distributed/nativeResults.js'
import { DistributedArtifactPublicationService, type AcceptedArtifactPublication, type ArtifactPublicationAuthority } from '../../files/distributed/publication.js'
import type { DistributedPublicationLink } from '../../files/distributed/publicationLedger.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { NativeArtifactOutputs, type NativeArtifactOutput, type NativeArtifactOutputRepository } from './nativeArtifactOutputs.js'
import { WorkflowArtifactResultAdoption, type VerifiedWorkflowArtifactSource } from './workflowArtifactResultAdoption.js'
import { artifactWorkflowReceipt, completeResultRepair } from './workflowRepair.test-support.js'

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

// Synthetic original-native source/current-grant boundaries ONLY. Canonical
// file bytes, publication reader and immutable adoption service are real here;
// these unit fixtures cannot authorize production or prove physical execution.
async function fixture(keys = ['report']) {
  const f = await fileToolFixture(), body = Buffer.from('exact original publication bytes')
  if (f.scope.chat.kind !== 'agent') throw new Error('fixture')
  f.scope.chat.runId = randomUUID(); f.scope.chat.executionId = randomUUID()
  const accepted: AcceptedArtifactPublication = { context: f.context,
    attempt: { workspaceId: f.scope.chat.workspaceId, workflowId: f.scope.chat.workflowId, runId: f.scope.chat.runId,
      nodeId: 'producer', executionId: f.scope.chat.executionId, attemptId: randomUUID(), placementHash: hash('placement') },
    transferContext: { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() } }
  const execution: HarnessExecution = { id: accepted.attempt.executionId, runId: accepted.attempt.runId,
    workflowNodeId: 'producer', agentId: f.scope.chat.agentId, agentConfigurationVersionId: 'configuration', attempt: 1,
    nativeSessionId: f.context.nativeSessionId, state: 'running', input: {}, createdAt: f.clock().toISOString() }
  const version = WorkflowVersionV3Schema.parse({ id: randomUUID(), workspaceId: accepted.attempt.workspaceId,
    workflowId: accepted.attempt.workflowId, version: 1, executionSemanticsVersion: 3, entryNodeId: 'producer',
    definition: { id: accepted.attempt.workflowId, workspaceId: accepted.attempt.workspaceId, name: 'Original', version: 1,
      executionSemanticsVersion: 3, entryNodeId: 'producer', executionCondition: { kind: 'manual' }, approval: { handler: 'user' },
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 }, nodes: [{ id: 'producer', agentId: execution.agentId,
        name: 'Producer', artifactOutputs: { version: 1, outputKeys: keys } }], edges: [] },
    agentConfigurationVersionIds: { [execution.agentId]: execution.agentConfigurationVersionId }, approval: { handler: 'user' },
    contentHash: repeatDigest('original saved version'), createdAt: execution.createdAt })
  const command = `execution:${execution.id}`, publicationCommand: string = randomUUID()
  const node = version.definition.nodes[0]!
  if (node.kind === 'job') throw new Error('fixture')
  const envelope = { data: { original: true }, artifactOutputs: { version: 1,
    outputs: keys.map(outputKey => ({ outputKey, commandId: publicationCommand })) } }
  const result: ExecutionResult = { outcome: 'succeeded', output: { text: JSON.stringify(envelope) } }
  const proof: WorkflowNativeProofRecord = { proofId: randomUUID(), scope: { workspaceId: version.workspaceId,
    workflowId: version.workflowId, runId: execution.runId, workflowVersionId: version.id, executionSemanticsVersion: 3 },
    ref: { nodeId: execution.workflowNodeId, occurrence: null }, execution: repeatExecutionIdentity(execution),
    inputDigest: repeatDigest(execution.input), commandId: command,
    session: { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: f.context.nativeSessionId },
    original: { type: 'history', history: { correlationId: command, nativeTurnId: f.context.turnId!,
      events: [{ sequence: 1, type: 'turn.completed', occurredAt: execution.createdAt,
        payload: { threadId: f.context.nativeSessionId, turnId: f.context.turnId, status: 'completed', clientCorrelationId: command } }],
      pendingInteractions: [], terminalTurn: { correlationId: command, providerId: f.context.turnId!, result } } },
    observedAt: execution.createdAt, ownerId: 'unit-owner', ownerFence: '1', lifetimeGeneration: 1, closureGeneration: '1',
    lane: { id: 'unit-lane', token: 'unit-token', connectionGeneration: 1, providerId: f.context.turnId! } }
  const current = vi.fn(async () => {})
  const original = { version, execution, proof, sourceDigest: repeatDigest(proof), assertCurrent: current,
    remote: artifactWorkflowReceipt(accepted, result),
    publicationContext: async () => ({ ...accepted, context: f.context }),
  } satisfies VerifiedWorkflowArtifactSource & { remote: ReturnType<typeof artifactWorkflowReceipt>;
    publicationContext(commandId: string): Promise<AcceptedArtifactPublication> }
  const source = { readVerified: vi.fn(async () => original) }
  const root = await mkdtemp(join(process.cwd(), '.workflow-artifact-adoption-test-')); roots.push(root)
  const files = new TemporaryFileService(f.repository, new FileByteStorage(root, MAX_FILE_BYTES), { resolve: async () => f.scope }, undefined, f.clock)
  const receipt: VerifiedTransferReceipt = { version: 1, receiptId: randomUUID(), transferId: randomUUID(), sha256: hash(body), byteSize: body.length,
    verifiedAt: f.clock().toISOString(), intent: { version: 1, ...accepted.transferContext, transferId: '', operationId: randomUUID(),
      executionId: execution.id, attemptId: accepted.attempt.attemptId, placementHash: accepted.attempt.placementHash,
      rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact', sha256: hash(body), byteSize: body.length,
      manifestDigest: hash('manifest'), expiresAt: new Date(f.clock().getTime() + 60_000).toISOString(), chunkBytes: 1024 } }
  receipt.intent.transferId = receipt.transferId
  const links = new Map<string, DistributedPublicationLink>()
  const ledger = { read: async (_owner: string, id: string) => links.get(id), linkPublication: async (link: DistributedPublicationLink) => {
    if (!links.has(link.requestId)) links.set(link.requestId, structuredClone(link))
  } }
  const authority = { authorize: vi.fn<ArtifactPublicationAuthority['authorize']>(async () => ({ context: f.context, principal: f.principal, binding: hash('native binding') })),
    assertSourceLive: vi.fn(async () => {}) }
  const transfers = { resolveVerifiedReceipt: async () => receipt, openVerified: async () => Readable.from([body]) }
  const publisher = new DistributedArtifactPublicationService(files, ledger, transfers, authority, f.clock)
  const publish = (commandId = publicationCommand) => publisher.publishAccepted(accepted, receipt.transferId,
    { commandId, artifactId: randomUUID(), scope: f.scope, filename: 'report.md', mediaType: 'text/markdown' })
  const records = new Map<string, NativeArtifactOutput>()
  const repository = { read: async (_producer: unknown, key: string) => records.get(key),
    bind: vi.fn<NativeArtifactOutputRepository['bind']>(async (record, authorize) => {
      await authorize({ query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) })
      const prior = records.get(record.outputKey)
      if (prior && !isDeepStrictEqual(prior, record)) throw new DomainError('NATIVE_ARTIFACT_OUTPUT_CONFLICT', 'Original binding differs.', 409)
      if (!prior) records.set(record.outputKey, structuredClone(record))
      return structuredClone(prior ?? record)
    }) }
  const results = new CanonicalNativeArtifactResults(files, ledger, authority, f.clock)
  const native = new NativeArtifactOutputs(results, repository, authority, { pinAccepted: async value => value })
  const outputs = { acceptOutput: vi.fn(native.acceptOutput.bind(native)) }
  const adoption = new WorkflowArtifactResultAdoption(source, outputs)
  const refresh = () => { original.sourceDigest = repeatDigest(proof) }
  const setResult = (value: ExecutionResult) => {
    if (proof.original.type !== 'history') throw new Error('fixture')
    proof.original.history.terminalTurn!.result = value
    const payload = proof.original.history.events[0]?.payload
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      payload.status = value.outcome === 'succeeded' ? 'completed' : value.outcome === 'failed' ? 'failed' : 'interrupted'
    }
    refresh()
  }
  return { f, accepted, execution, original, source, current, proof, node, envelope, result, receipt, publicationCommand,
    records, repository, native, outputs, adoption, publish, refresh, setResult, authority }
}

describe('saved original workflow artifact result adoption', () => {
  it.each([{ count: 1, retried: false }, { count: 2, retried: false }, { count: 1, retried: true }])(
    'adopts earlier publications without changing provenance ($count corrections, retried=$retried)', async ({ count, retried }) => {
    const t = await fixture()
    const published = await t.publish()
    const publication = structuredClone(t.accepted)
    if (retried) {
      t.original.remote.nativeTurnRetries = [{ previousTurnId: t.original.remote.native!.turnId!, turnId: 'native-retry' }]
      t.original.remote.native!.turnId = 'native-retry'
    }
    let correlationId = t.proof.commandId
    for (let attempt = 1; attempt <= count; attempt++) {
      correlationId = completeResultRepair(t.original.remote, `corrective-${attempt}`)
    }
    const turnId = t.original.remote.native!.turnId!
    t.accepted.context = { ...t.accepted.context, turnId }
    if (t.proof.original.type !== 'history') throw new Error('Expected terminal history')
    const history = t.proof.original.history
    history.correlationId = correlationId
    history.nativeTurnId = turnId
    history.terminalTurn = { ...history.terminalTurn!, correlationId, providerId: turnId }
    history.events[0]!.payload = { threadId: t.execution.nativeSessionId, turnId,
      clientCorrelationId: correlationId, status: 'completed' }
    t.proof.lane!.providerId = turnId
    t.refresh()
    const before = structuredClone({ proof: t.proof, remote: t.original.remote, publication })
    const adopted = await t.adoption.adoptOriginalOutputs(t.accepted)
    expect(adopted.status).toBe('adopted')
    expect(t.records.get('report')).toMatchObject({ commandId: t.publicationCommand,
      nativeIdentity: { nativeSessionId: publication.context.nativeSessionId, turnId: publication.context.turnId },
      pins: { fileId: published.value.file.fileId, revisionId: published.value.revision.revisionId } })
    expect({ proof: t.proof, remote: t.original.remote, publication }).toEqual(before)
  })

  it('resolves the saved name/original command to canonical bytes and original receipt', async () => {
    const t = await fixture(), published = await t.publish()
    const before = structuredClone({ result: t.result, version: t.original.version, accepted: t.accepted })
    const adopted = await t.adoption.adoptOriginalOutputs(t.accepted)
    expect(adopted).toEqual({ status: 'adopted', outputs: [...t.records.values()] })
    expect(adopted.status === 'adopted' && adopted.outputs[0]).toMatchObject({ outputKey: 'report', commandId: t.publicationCommand,
      pins: { fileId: published.value.file.fileId, revisionId: published.value.revision.revisionId, sha256: t.receipt.sha256 }, transferReceipt: t.receipt })
    expect({ result: t.result, version: t.original.version, accepted: t.accepted }).toEqual(before)
    expect(t.current).toHaveBeenCalledTimes(3)
  })
  it('publishes original bytes for a combined handoff result and restores the same associations', async () => {
    const t = await fixture()
    t.original.version.definition.handoffs = { contractVersion: 1 }
    const result: ExecutionResult = { outcome: 'succeeded', output: { text: JSON.stringify({
      ...t.envelope, routing: { kind: 'finish' },
      data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
    }) } }
    t.setResult(result)
    const before = structuredClone(result)
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toMatchObject({ code: 'FILE_PUBLICATION_PENDING' })
    expect(t.records.size).toBe(0)
    const published = await t.publish()
    expect((await t.adoption.adoptOriginalOutputs(t.accepted)).status).toBe('adopted')
    const first = structuredClone(t.records.get('report'))
    const restored = new WorkflowArtifactResultAdoption(t.source, t.outputs)
    expect(await restored.adoptOriginalOutputs(t.accepted)).toEqual({ status: 'adopted', outputs: [first] })
    expect(first?.pins.fileId).toBe(published.value.file.fileId)
    expect(first?.pins.sha256).toBe(t.receipt.sha256)
    expect(parseWorkHandoffResult(result)).toMatchObject({ routing: { kind: 'finish' },
      artifactOutputs: { outputs: [{ outputKey: 'report', commandId: t.publicationCommand }] } })
    expect(result).toEqual(before)
  })
  it('supports explicit alias names backed by one original publication', async () => {
    const t = await fixture(['report', 'summary']); await t.publish()
    const result = await t.adoption.adoptOriginalOutputs(t.accepted)
    expect(result.status === 'adopted' && result.outputs.map(output => output.commandId)).toEqual([t.publicationCommand, t.publicationCommand])
    expect(t.records.get('report')!.pins).toEqual(t.records.get('summary')!.pins)
  })
  it('leaves undeclared artifact-looking text unavailable without adopting anything', async () => {
    const t = await fixture(); delete t.node.artifactOutputs
    expect(await t.adoption.adoptOriginalOutputs(t.accepted)).toEqual({ status: 'unavailable', reason: 'not_declared' })
    expect(t.outputs.acceptOutput).not.toHaveBeenCalled()
  })
  it('passes the saved choice declaration and preserves repeat-compatible data', async () => {
    const t = await fixture(); await t.publish()
    t.node.choice = { outcomes: [{ outcome: 'pass', target: { kind: 'branch_end' } }] }
    const data = { latestDeliverable: { original: true }, remainingFindings: [] }
    t.setResult({ outcome: 'succeeded', output: { text: JSON.stringify({ ...t.envelope, data, routing: { outcome: 'pass' } }) } })
    expect((await t.adoption.adoptOriginalOutputs(t.accepted)).status).toBe('adopted')
    expect(t.proof.original.type === 'history' && t.proof.original.history.terminalTurn!.result.output).toEqual({ text: JSON.stringify({ ...t.envelope, data, routing: { outcome: 'pass' } }) })
  })
  it.each(['undeclared', 'duplicate', 'missing', 'mixed', 'failed', 'invalid-command'] as const)('rejects %s result before any output bind', async kind => {
    const t = await fixture(); const changed = structuredClone(t.envelope)
    if (kind === 'undeclared') changed.artifactOutputs.outputs[0]!.outputKey = 'caller-key'
    if (kind === 'duplicate') changed.artifactOutputs.outputs.push(changed.artifactOutputs.outputs[0]!)
    if (kind === 'missing') changed.artifactOutputs.outputs = []
    if (kind === 'invalid-command') changed.artifactOutputs.outputs[0]!.commandId = 'x'
    t.setResult(kind === 'failed' ? { outcome: 'failed', error: { code: 'NATIVE_FAILED', message: 'failure', retryable: false } }
      : { outcome: 'succeeded', output: kind === 'mixed' ? { text: JSON.stringify(changed), artifactOutputs: changed.artifactOutputs } : { text: JSON.stringify(changed) } })
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_RESULT_INVALID' })
    expect(t.outputs.acceptOutput).not.toHaveBeenCalled(); expect(t.records.size).toBe(0)
  })
  it.each(['scope', 'execution', 'configuration', 'digest', 'input', 'turn', 'terminal-result'] as const)('rejects foreign %s source before binding', async kind => {
    const t = await fixture()
    if (kind === 'scope') t.proof.scope.runId = randomUUID()
    if (kind === 'execution') t.proof.execution.executionId = randomUUID()
    if (kind === 'configuration') t.execution.agentConfigurationVersionId = 'replacement'
    if (kind === 'input') t.proof.inputDigest = repeatDigest('replacement')
    if (kind === 'turn') t.proof.lane!.providerId = 'replacement'
    if (kind === 'terminal-result') {
      t.execution.state = 'completed'; t.execution.finishedAt = t.proof.observedAt
      t.execution.result = { outcome: 'succeeded', output: { text: 'replacement' } }
    }
    t.refresh(); if (kind === 'digest') t.original.sourceDigest = repeatDigest('replacement')
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toBeInstanceOf(DomainError)
    expect(t.outputs.acceptOutput).not.toHaveBeenCalled()
  })
  it('refuses convenience-only terminal without a genuine original terminal frame', async () => {
    const t = await fixture()
    if (t.proof.original.type !== 'history') throw new Error('fixture')
    t.proof.original.history.events = []; t.refresh()
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toMatchObject({ code: 'NATIVE_TERMINAL_SOURCE_REQUIRED' })
    expect(t.outputs.acceptOutput).not.toHaveBeenCalled()
  })
  it('does not mistake a transfer receipt or missing command for publication', async () => {
    const t = await fixture()
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toMatchObject({ code: 'FILE_PUBLICATION_PENDING' })
    expect(t.records.size).toBe(0)
  })
  it('reconstructs after lost binding ACK and ignores a later publication', async () => {
    const t = await fixture(); await t.publish()
    const bind = t.repository.bind.getMockImplementation()!
    t.repository.bind.mockImplementationOnce(async (...args) => { await bind(...args); throw new Error('mapping ACK lost') })
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toThrow('mapping ACK lost')
    const first = structuredClone(t.records.get('report')); await t.publish(randomUUID())
    const restored = new WorkflowArtifactResultAdoption(t.source, t.outputs)
    expect(await restored.adoptOriginalOutputs(t.accepted)).toEqual({ status: 'adopted', outputs: [first] })
    expect(t.records.size).toBe(1)
    t.envelope.artifactOutputs.outputs[0]!.commandId = randomUUID()
    await t.publish(t.envelope.artifactOutputs.outputs[0]!.commandId)
    t.setResult({ outcome: 'succeeded', output: { text: JSON.stringify(t.envelope) } })
    await expect(restored.adoptOriginalOutputs(t.accepted)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
    expect(t.records.get('report')).toEqual(first)
  })
  it('reports partial adoption as pending and retries only the same original mappings', async () => {
    const t = await fixture(['report', 'summary']); await t.publish()
    const second = randomUUID(); t.envelope.artifactOutputs.outputs[1]!.commandId = second
    t.setResult({ outcome: 'succeeded', output: { text: JSON.stringify(t.envelope) } })
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toMatchObject({ code: 'FILE_PUBLICATION_PENDING' })
    const first = structuredClone(t.records.get('report')); expect(t.records.size).toBe(1)
    await t.publish(second)
    expect((await t.adoption.adoptOriginalOutputs(t.accepted)).status).toBe('adopted')
    expect(t.records.get('report')).toEqual(first); expect(t.records.size).toBe(2)
  })
  it.each(['before', 'after'] as const)('rejects lost source ownership %s canonical bind without success', async phase => {
    const t = await fixture(); await t.publish()
    t.current.mockImplementation(async () => {})
    if (phase === 'before') t.current.mockRejectedValueOnce(new DomainError('RUN_OWNERSHIP_LOST', 'lost original', 409))
    else t.current.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DomainError('RUN_OWNERSHIP_LOST', 'lost original', 409))
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toMatchObject({ code: 'RUN_OWNERSHIP_LOST' })
    if (phase === 'before') expect(t.outputs.acceptOutput).not.toHaveBeenCalled()
    else expect(t.records.size).toBe(1) // retained immutable mapping is not successor acceptance
  })
  it('preserves canonical publication authorization and expiry failures', async () => {
    const t = await fixture(); await t.publish()
    t.authority.authorize.mockRejectedValueOnce(new DomainError('FILE_TOOL_DENIED', 'revoked', 403))
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
    expect(t.records.size).toBe(0)
    t.f.advance(31 * 24 * 60 * 60 * 1000)
    await expect(t.adoption.adoptOriginalOutputs(t.accepted)).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
    expect(t.records.size).toBe(0)
  })
  it('does not allow a source object mutation during an authority await to change the parsed mapping', async () => {
    const t = await fixture(); await t.publish()
    t.current.mockImplementationOnce(async () => {
      t.envelope.artifactOutputs.outputs[0]!.commandId = randomUUID()
      t.setResult({ outcome: 'succeeded', output: { text: JSON.stringify(t.envelope) } })
    })
    // The source port must reject a changed durable record in production. Even
    // this permissive unit double cannot replace the consumer's captured value.
    expect((await t.adoption.adoptOriginalOutputs(t.accepted)).status).toBe('adopted')
    expect(t.records.get('report')!.commandId).toBe(t.publicationCommand)
  })
})
