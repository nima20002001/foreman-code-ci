import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { ExclusiveGraphConnection } from '../../run-graph/connection.js'
import { readDispatchIntent } from '../../placement/persistence.js'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { bindingIdentity } from '../../files/tools/context.js'
import type { FileToolContext } from '../../files/tools/types.js'
import type { AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { NativeArtifactOutputSchema } from './nativeArtifactOutputs.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { createWorkflowArtifactOutputsGate } from './workflowArtifactAcceptance.js'
import { completeResultRepair } from './workflowRepair.test-support.js'

vi.mock('../../placement/persistence.js', () => ({ readDispatchIntent: vi.fn() }))
vi.mock('./persistence.js', () => ({ readReconciledDispatchIntent: vi.fn() }))
vi.mock('../../run-graph/repeatReceipts.js', () => ({
  assertRepeatCanonicalReceiptLocked: vi.fn(async () => {}), requireRepeatCanonicalReceiptBeforeCommit: vi.fn(),
}))
beforeEach(() => vi.resetAllMocks())

// Scripted SQL and authority boundaries only; real gate, graph transaction,
// immutable mapping reader, publication metadata verifier and parsers. These
// fixtures do not establish physical qualification, bytes or live grants.
function fixture() {
  const f = makeCurrentWorkflowFixture('artifact-acceptance', 'single'), node = f.version.definition.nodes[0]!
  node.artifactOutputs = { version: 1, outputKeys: ['z', 'a'] }
  const run = { ...f.run, authorizationPrincipalId: 'owner' } as AcceptedWorkflowRunV3
  const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID(), digest = 'a'.repeat(64)
  const execution: HarnessExecution = { id: randomUUID(), runId: run.id, workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId]!, attempt: 1, state: 'completed',
    nativeSessionId: 'original-session', input: {}, createdAt: f.createdAt, finishedAt: f.createdAt,
    result: { outcome: 'succeeded', output: { text: JSON.stringify({ data: null, artifactOutputs: { version: 1,
      outputs: ['z', 'a'].map(outputKey => ({ outputKey, commandId: `original-command-${outputKey}` })) } }) } } }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: run.id, nodeId: node.id,
    hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest,
      rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest },
    source: { kind: 'pending', approvedSourceId: randomUUID(), snapshotId: randomUUID(), rootId: randomUUID(), bindingRevision: 1,
      revisionId: 'source', manifestDigest: digest, materializationId: null, materializationDigest: null },
    payload: { kind: 'agent', agentId: node.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
      artifactOutputs: node.artifactOutputs, driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
      harnessInstallationId: 'harness', installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: execution.id, attemptId: randomUUID(), operationId: randomUUID(),
    occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, inputDigest: repeatDigest(execution.input), owner: { grantId: 'grant', epoch: '1' } })
  const transferContext = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const context: FileToolContext = { ownerPrincipalId: 'owner', scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation',
    workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, executionId: execution.id, agentId: node.agentId } },
    nativeSessionId: 'original-session', turnId: 'original-turn', allowMutation: true, allowedTools: ['files.list', 'files.publish_result'] }
  const producer = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, nodeId: node.id,
    executionId: execution.id, attemptId: intent.attemptId, placementHash: intent.bindingHash }
  const accepted: AcceptedArtifactPublication = { attempt: producer, context, transferContext }
  const records = ['z', 'a'].map((outputKey, index) => {
    const sha256 = (index ? 'b' : 'c').repeat(64), transferId = randomUUID()
    return NativeArtifactOutputSchema.parse({ version: 1, producer, outputKey, commandId: `original-command-${outputKey}`,
      nativeIdentity: { nativeSessionId: context.nativeSessionId, turnId: context.turnId }, scope: context.scope,
      publication: { ownerPrincipalId: 'owner', requestId: `original-command-${outputKey}`, binding: bindingIdentity(context) },
      pins: { fileId: randomUUID(), revisionId: randomUUID(), sha256, byteSize: 12 },
      transferReceipt: { version: 1, receiptId: randomUUID(), transferId, sha256, byteSize: 12, verifiedAt: f.createdAt,
        intent: { version: 1, ...transferContext, transferId, operationId: intent.operationId, executionId: execution.id, attemptId: intent.attemptId,
          placementHash: intent.bindingHash, rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact',
          sha256, byteSize: 12, manifestDigest: digest, chunkBytes: 1024, expiresAt: '2099-01-01T00:00:00.000Z' } } })
  })
  const proof: WorkflowNativeProofRecord = { proofId: randomUUID(), scope: f.scope, ref: { nodeId: node.id, occurrence: null },
    execution: repeatExecutionIdentity(execution), inputDigest: repeatDigest(execution.input), commandId: `execution:${execution.id}`,
    session: { harness: 'codex', providerVersion: 'unit-no-provider', nativeSessionId: 'original-session' },
    original: { type: 'history', history: { correlationId: `execution:${execution.id}`, nativeTurnId: 'original-turn',
      events: [{ sequence: 1, type: 'turn.completed', occurredAt: f.createdAt, payload: { threadId: 'original-session', turnId: 'original-turn', status: 'completed' } }],
      pendingInteractions: [], terminalTurn: { correlationId: `execution:${execution.id}`, providerId: 'original-turn', result: execution.result! } } },
    observedAt: f.createdAt, ownerId: 'unit-owner', ownerFence: '1', lifetimeGeneration: 1, closureGeneration: '1',
    lane: { id: 'unit-lane', token: 'unit-token', connectionGeneration: 1, providerId: 'original-turn' } }
  const remote = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent,
    connection: { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: transferContext.bootId, connectionGeneration: 1 },
    workerIncarnationId: randomUUID(), sequence: 3, phase: 'confirmed_terminal', native: { sessionId: 'original-session', turnId: 'original-turn', processIdentityDigest: digest },
    entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [],
    terminal: { kind: 'completed', closureEvidenceDigest: digest, result: execution.result, artifactDigests: ['b'.repeat(64), 'c'.repeat(64)] } })
  const state = { missing: '', expired: false, revoked: false, proofDigest: repeatDigest(proof, 4 * 1024 * 1024),
    precedingProofs: [] as WorkflowNativeProofRecord[], committed: false, queries: [] as string[] }
  const client = { query: vi.fn(async (text: string, values: unknown[] = []) => {
    state.queries.push(text); let rows: unknown[] = []
    if (text === 'commit') state.committed = true
    else if (text.includes('from workflow_native_proofs')) rows = [
      ...state.precedingProofs.map(record => ({ record, source_digest: repeatDigest(record, 4 * 1024 * 1024) })),
      { record: proof, source_digest: state.proofDigest },
    ]
    else if (text.includes('from remote_execution_receipts')) rows = [{ receipt: remote }]
    else if (text.includes('from execution_work_result_repairs')) rows = [{ attempt: remote.resultRepairs?.length ?? 0 }]
    else if (text.includes('from management_command_receipts')) {
      const key = JSON.parse(values[1] as string)[3] as string
      rows = key === state.missing ? [] : [{ result: records.find(output => output.outputKey === key) }]
    } else if (text.includes('select p.record from file_tool_publications')) {
      const output = records.find(output => output.publication.requestId === values[1])!
      rows = [{ record: { ...output.publication, context, ref: { fileId: output.pins.fileId, revisionId: output.pins.revisionId }, transferReceipt: output.transferReceipt } }]
    } else if (text.startsWith('select file_id from files')) rows = state.expired ? [] : [{ file_id: values[0] }]
    return { rows, rowCount: rows.length, fields: [], command: '', oid: 0 }
  }) }
  const connection = new ExclusiveGraphConnection(client as unknown as pg.ClientBase, () => {})
  const authority = { resolveWorkflowContext: vi.fn(async () => accepted), authorize: vi.fn(async () => {
    if (state.revoked) throw new Error('AUTH_REVOKED')
    return { principal: { id: 'owner' }, context, binding: bindingIdentity(context) } as Awaited<ReturnType<import('./nativeArtifactAuthority.js').PostgresArtifactPublicationAuthority['authorize']>>
  }) }
  vi.mocked(readDispatchIntent).mockResolvedValue(intent); vi.mocked(readReconciledDispatchIntent).mockResolvedValue(intent)
  const publications = Object.assign(authority, { resolvePublicationContext: async () => accepted,
    authorizePublication: authority.authorize })
  const gate = createWorkflowArtifactOutputsGate(mainId, publications)
  const check = (after = async () => {}) => connection.transaction(async sql => { await gate(sql, run, f.version, execution); await after() })
  return { check, state, records, proof, remote, execution, f, authority, context }
}

describe('durable original artifact completeness before result acceptance', () => {
  it.each([1, 2])('accepts the final repair after %s corrections and preserves earlier artifact identities', async count => {
    const f = fixture()
    const originalRecords = structuredClone(f.records)
    f.state.precedingProofs.push(structuredClone(f.proof))
    let correlationId = f.proof.commandId
    for (let attempt = 1; attempt <= count; attempt++) correlationId = completeResultRepair(f.remote, `corrective-${attempt}`)
    if (f.proof.original.type !== 'history') throw new Error('Expected terminal history')
    const turnId = f.remote.native!.turnId!
    f.proof.original.history.correlationId = correlationId
    f.proof.original.history.nativeTurnId = turnId
    f.proof.original.history.terminalTurn = { ...f.proof.original.history.terminalTurn!, correlationId, providerId: turnId }
    f.proof.original.history.events[0]!.payload = { threadId: f.execution.nativeSessionId, turnId,
      clientCorrelationId: correlationId, status: 'completed' }
    f.proof.lane!.providerId = turnId
    f.state.proofDigest = repeatDigest(f.proof, 4 * 1024 * 1024)
    await f.check()
    expect(f.state.committed).toBe(true)
    expect(f.records).toEqual(originalRecords)
  })

  it.each(['invalid_result', 'missing_publication'] as const)('refuses persisted %s before output adoption', async reason => {
    const f = fixture()
    const original = structuredClone(f.execution.result)
    f.remote.terminal!.artifactDigests = []
    f.remote.terminal!.artifactValidationError = { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT', reason }
    await expect(f.check()).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT' })
    expect(f.state.committed).toBe(false)
    expect(f.execution.result).toEqual(original)
    expect(f.authority.authorize).not.toHaveBeenCalled()
  })
  it('resamples all original canonical mappings and authority before COMMIT and on replay', async () => {
    const f = fixture()
    const before = structuredClone({ records: f.records, proof: f.proof, remote: f.remote })
    await f.check(); await f.check()
    expect(f.state.committed).toBe(true)
    expect(f.authority.authorize).toHaveBeenCalledTimes(8)
    expect({ records: f.records, proof: f.proof, remote: f.remote }).toEqual(before)
    expect(f.authority.resolveWorkflowContext).toHaveBeenCalledTimes(4)
  })
  it.each(['missing', 'command', 'digest', 'source', 'session', 'expired', 'revoked'] as const)('rejects %s instead of exposing partial success', async field => {
    const f = fixture()
    if (field === 'missing') f.state.missing = 'a'
    if (field === 'command') f.records[0]!.commandId = 'foreign-command'
    if (field === 'digest') f.remote.terminal!.artifactDigests!.reverse()
    if (field === 'source') f.state.proofDigest = `sha256:${'0'.repeat(64)}`
    if (field === 'session') f.records[0]!.nativeIdentity.nativeSessionId = 'replacement-session'
    if (field === 'expired') f.state.expired = true
    if (field === 'revoked') f.state.revoked = true
    await expect(f.check()).rejects.toThrow(); expect(f.state.committed).toBe(false)
  })
  it.each(['expiry', 'revocation', 'mapping'] as const)('rolls back when %s changes after the first gate and before COMMIT', async field => {
    const f = fixture()
    await expect(f.check(async () => {
      if (field === 'expiry') f.state.expired = true
      if (field === 'revocation') f.state.revoked = true
      if (field === 'mapping') f.state.missing = 'a'
    })).rejects.toThrow()
    expect(f.state.committed).toBe(false)
  })
})
