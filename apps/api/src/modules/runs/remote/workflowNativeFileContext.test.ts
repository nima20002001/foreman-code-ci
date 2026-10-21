import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion, type HarnessExecution } from '@foreman-code/contracts'
import type { ArtifactAttempt } from '@foreman-code/contracts/artifact-edges'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { createWorkflowNativeCaptureChannel, type WorkflowNativeCaptureInput } from '../../interactions/workflowNativeCapture.js'
import { ExclusiveGraphConnection, type GraphTransactionSql } from '../../run-graph/connection.js'
import { currentRunGraphPublication } from '../../run-graph/publication.js'
import { readDispatchIntent, readAcceptedPlacement } from '../../placement/persistence.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { assertDeviceHostInstallation } from '../../devices/hostAuthorization.js'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import type { RepeatNativeEvidence } from '../repeatNativeRepository.js'
import { agentChatKey } from '../../conversations/agentChatRepository.js'
import { runChatStorageKey } from '../../conversations/selectedRunChat.js'
import { DomainError } from '../../errors.js'
import { PostgresArtifactPublicationAuthority } from './nativeArtifactAuthority.js'
import { WorkflowNativeFileContextAdmission, WORKFLOW_NATIVE_FILE_CONTEXT_OPERATION, workflowNativeFileConversationKey } from './workflowNativeFileContext.js'
import { completeResultRepair } from './workflowRepair.test-support.js'

vi.mock('../../placement/persistence.js', () => ({ readDispatchIntent: vi.fn(), readAcceptedPlacement: vi.fn(), readNativePlacement: vi.fn() }))
vi.mock('./persistence.js', () => ({ readReconciledDispatchIntent: vi.fn() }))
vi.mock('../../devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: vi.fn() }))
vi.mock('../../run-graph/publication.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../run-graph/publication.js')>(), currentRunGraphPublication: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

// Private UNIT capture channel and SQL/provider boundaries only. These fixtures
// cannot authorize the production channel and are not database or physical proof.
function fixture() {
  const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID(), hash = 'a'.repeat(64)
  const configuration: AgentConfigurationVersion = { id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1,
    prompt: { system: 'accepted' }, assignedSkills: [], harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write' },
    contentHash: 'sha256:accepted', createdAt: '2026-10-01T00:00:00.000Z' }
  const execution: HarnessExecution = { id: randomUUID(), runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1, nativeSessionId: 'original-session', workingDirectory: '/original/worktree',
    runtimeDirectory: '/original/runtime', state: 'running', input: { task: 'original' }, createdAt: configuration.createdAt }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: execution.runId, nodeId: execution.workflowNodeId,
    hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: hash,
      rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: hash },
    source: { kind: 'pending', approvedSourceId: randomUUID(), snapshotId: randomUUID(), revisionId: 'source', manifestDigest: hash,
      rootId: randomUUID(), bindingRevision: 1, materializationId: null, materializationDigest: null },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1', instanceId: 'instance',
      instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: hash, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: execution.id, attemptId: randomUUID(), operationId: randomUUID(), occurrenceId: null,
    occurrenceIndex: 0, technicalAttempt: 1, inputDigest: `sha256:${hash}`, owner: { grantId: 'grant', epoch: '1' } })
  const session = { harness: 'codex' as const, providerVersion: '0.154.0', nativeSessionId: execution.nativeSessionId! }
  const transfer = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const remote: RemoteOperationReceipt = { schemaVersion: 1, intent, connection: { mainId, deviceId, workerInstallationId,
    keyRevision: 1, authorizationRevision: 1, bootId: transfer.bootId, connectionGeneration: 1 }, workerIncarnationId: randomUUID(), sequence: 2,
    phase: 'running', native: { sessionId: session.nativeSessionId, turnId: 'original-turn', processIdentityDigest: hash },
    entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [] }
  const state = { owned: true, resident: true, leaseHeld: true, ownerFence: '1', stopped: false, runState: 'running', revoked: false,
    grantLive: true, proofAvailable: true, closureLive: true, laneLive: true, canonical: true, loseAck: false,
    repairAttempt: 0, laneCorrelation: undefined as string | undefined,
    expectedReference: session as typeof session | null,
    boundSession: session as typeof session | null,
    conversation: undefined as { id: string; key: string; record: unknown } | undefined,
    receipt: undefined as { principal_id: string; command_id: string; input_hash: string; result: unknown } | undefined,
    audits: 0, commits: 0, queries: [] as string[] }
  const owner = { runId: execution.runId, assertOwned: () => { if (!state.owned) throw new DomainError('RUN_OWNERSHIP_LOST', 'owner lost', 409) },
    readOneShotFence: async () => ({ ownerId: 'owner', fence: state.ownerFence }) }
  const lease = { fence: { id: 'lane', token: 'unit-lease' }, previous: { connectionGeneration: 1 }, providerId: 'original-turn' }
  const channel = createWorkflowNativeCaptureChannel()
  const captureInput = { owner, execution, session, lease, lifetimeGeneration: 1, closureGeneration: '1', kind: 'live',
    manager: { harness: 'codex', assertCapturedLease: () => { if (!state.leaseHeld) throw new Error('lease lost') } },
    source: { type: 'event', event: { executionId: execution.id, type: 'turn.started', sequence: 1, occurredAt: configuration.createdAt,
      payload: { threadId: session.nativeSessionId, turnId: lease.providerId } } },
    assertCurrent: () => { if (!state.resident) throw new Error('lifetime lost') } } as unknown as WorkflowNativeCaptureInput
  const evidence = channel.capture.capture(captureInput), capture = channel.verify.read(evidence)
  const proof: WorkflowNativeProofRecord = { proofId: 'original-proof', scope: { workspaceId: 'workspace', workflowId: 'workflow',
    workflowVersionId: 'version', runId: execution.runId, executionSemanticsVersion: 3 }, ref: { nodeId: execution.workflowNodeId, occurrence: null },
  execution: repeatExecutionIdentity(execution), inputDigest: intent.inputDigest, commandId: `execution:${execution.id}`, session,
  original: capture.source, observedAt: capture.observedAt, ownerId: 'owner', ownerFence: '1', lifetimeGeneration: 1, closureGeneration: '1', lane: capture.lane }
  const persistedProof = structuredClone(proof)
  let backup: Pick<typeof state, 'conversation' | 'receipt' | 'audits'> | undefined, committed = false
  const query = vi.fn(async (text: string, args: unknown[] = []) => {
    state.queries.push(text); let rows: unknown[] = [], rowCount = 0
    if (text.startsWith('begin')) { backup = structuredClone({ conversation: state.conversation, receipt: state.receipt, audits: state.audits }); committed = false }
    else if (text === 'rollback') { if (!committed && backup) Object.assign(state, backup) }
    else if (text === 'commit') { state.commits++; committed = true; if (state.loseAck) { state.loseAck = false; throw new Error('commit ACK lost') } }
    else if (text.includes('from workflow_native_proofs')) rows = state.proofAvailable ? [{ record: persistedProof, source_digest: repeatDigest(persistedProof) }] : []
    else if (text.includes('from execution_native_closures')) rows = [{ generation: '1',
      expected_reference: state.expectedReference, closed: !state.closureLive }]
    else if (text.includes('from native_session_lanes')) rows = [{ owner_agent_id: execution.agentId, harness: session.harness, native_session_id: session.nativeSessionId,
      token: state.laneLive ? lease.fence.token : 'replacement', generation: String(lease.previous.connectionGeneration),
      correlation: state.laneCorrelation ?? proof.commandId, provider_id: lease.providerId, held: true }]
    else if (text.includes('from execution_work_result_repairs')) rows = state.repairAttempt ? [{ attempt: state.repairAttempt }] : []
    else if (text.includes('from harness_executions e join runs')) rows = [{ execution, configuration, workspace_id: 'workspace', workflow_id: 'workflow',
      workflow_version_id: 'version', authorization_principal_id: 'run-owner', execution_state: state.runState, stopped: state.stopped }]
    else if (text.includes('from management_principals')) rows = [{ id: args[0], name: 'Original Run owner', audience: 'operator',
      grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }], expires_at: new Date('2099-01-01T00:00:00.000Z'),
      revoked_at: state.revoked ? new Date() : null, delegated_from: null }]
    else if (text.includes('from execution_dispatch_owner_grants')) rows = state.grantLive ? [{}] : []
    else if (text.startsWith('select 1 from runs r join harness_executions')) rows = !state.stopped && ['running', 'waiting'].includes(state.runState)
      && args[4] === execution.workingDirectory && args[5] === execution.runtimeDirectory ? [{}] : []
    else if (text.startsWith('insert into operator_conversations')) {
      if (!state.conversation) { state.conversation = { id: args[0] as string, key: args[1] as string, record: JSON.parse(args[12] as string) }; rowCount = 1 }
    } else if (text.includes('from operator_conversations')) {
      const c = state.conversation
      if (c && (!text.includes('and record=$13::jsonb') || c.id === args[0] && c.key === args[1] && JSON.stringify(c.record) === args[12])) rows = [{ id: c.id, record: c.record }]
    } else if (text.includes('from remote_dispatch_origins')) rows = [{ connection: remote.connection }]
    else if (text.includes('from execution_native_sessions')) rows = state.boundSession ? [{ reference: state.boundSession }] : []
    else if (text.includes('from remote_execution_receipts')) rows = [{ receipt: remote }]
    else if (text.startsWith('insert into management_command_receipts')) {
      if (!state.receipt) { state.receipt = { principal_id: args[0] as string, command_id: args[2] as string,
        input_hash: args[4] as string, result: JSON.parse(args[5] as string) }; rowCount = 1 }
    } else if (text.includes('from management_command_receipts')) rows = state.receipt ? [state.receipt] : []
    else if (text.startsWith('insert into management_audit')) { state.audits++; rowCount = 1 }
    else if (text.includes('from runs r join workflow_versions')) rows = state.canonical ? [{ workspace_id: 'workspace', workflow_id: 'workflow',
      workflow_version_id: 'version', execution_semantics_version: 3, protocol_version: 1, head_sequence: '2', source_digest: repeatDigest(persistedProof),
      source_semantic_digest: `sha256:${hash}`, source_sequence: '2', effect_digest: null, effect_semantic_digest: null, effect_sequence: null }] : []
    return { rows, rowCount: rows.length || rowCount, command: '', oid: 0, fields: [] }
  })
  const client = { query } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(client, owner.assertOwned)
  vi.mocked(readDispatchIntent).mockResolvedValue(intent); vi.mocked(readReconciledDispatchIntent).mockResolvedValue(intent)
  vi.mocked(readAcceptedPlacement).mockResolvedValue(placement)
  vi.mocked(assertDeviceHostInstallation).mockResolvedValue({ keyRevision: 1, authorizationRevision: 1 } as NonNullable<Awaited<ReturnType<typeof assertDeviceHostInstallation>>>)
  const source = { evidence: { sourceKind: 'native_event' as const, sourceId: proof.proofId, sourceRevision: '1' }, sourceDigest: repeatDigest(persistedProof), semanticDigest: `sha256:${hash}` }
  const retainNativeSource = vi.fn(async (owner: unknown, proofId: string) => { void owner; void proofId; return source })
  vi.mocked(currentRunGraphPublication).mockReturnValue({ retainNativeSource } as unknown as ReturnType<typeof currentRunGraphPublication>)
  const authority = new PostgresArtifactPublicationAuthority(mainId, {} as pg.Pool,
    { locations: { revalidateRunAuthorization: async () => {} }, producer: { assertPinsCurrent: async () => {} } })
  const ports = { captures: channel.verify, assertPhysical: vi.fn(async () => {}), authority }
  const helper = new WorkflowNativeFileContextAdmission(mainId, ports)
  const admit = (input: RepeatNativeEvidence = evidence, actual: WorkflowNativeProofRecord = proof,
    after?: (sql: GraphTransactionSql) => Promise<void>) => connection.transaction(async sql => {
    const result = await helper.admitLocked(sql, input, actual, transfer); await after?.(sql); return result
  })
  const attempt: ArtifactAttempt = { workspaceId: 'workspace', workflowId: 'workflow', runId: execution.runId, nodeId: execution.workflowNodeId,
    executionId: execution.id, attemptId: intent.attemptId, placementHash: intent.bindingHash }
  return { mainId, execution, configuration, intent, remote, transfer, proof, state, evidence, channel, captureInput, connection,
    helper, ports, source, retainNativeSource, authority, admit, attempt, persistedProof,
    freshConnection: () => new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, owner.assertOwned) }
}
describe('genuine original workflow file-context admission', () => {
  it('rejects a corrective context whose publishing turn is disconnected from the native journal', async () => {
    const t = fixture()
    await t.admit()
    const before = structuredClone({ conversation: t.state.conversation, receipt: t.state.receipt })
    const correlationId = completeResultRepair(t.remote, 'corrective-turn')
    t.remote.nativeTurnRetries = []
    t.state.repairAttempt = 1
    t.state.laneCorrelation = correlationId
    t.captureInput.lease!.providerId = 'corrective-turn'
    const evidence = t.channel.capture.capture({ ...t.captureInput, source: { type: 'event', event: {
      executionId: t.execution.id, type: 'turn.started', sequence: 2, occurredAt: t.execution.createdAt,
      payload: { threadId: t.execution.nativeSessionId, turnId: 'corrective-turn', clientCorrelationId: correlationId },
    } } })
    const capture = t.channel.verify.read(evidence)
    const proof = { ...t.proof, proofId: 'disconnected-turn', original: capture.source, lane: capture.lane }
    await expect(t.freshConnection().transaction(sql =>
      t.helper.resolveOrAdmitLocked(sql, evidence, proof, t.transfer)))
      .rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_CONTEXT_CONFLICT' })
    expect({ conversation: t.state.conversation, receipt: t.state.receipt }).toEqual(before)
  })

  it.each([1, 2])('reuses the immutable admission for %s reserved corrective turns', async count => {
    const t = fixture()
    const original = await t.admit()
    const before = structuredClone({ conversation: t.state.conversation, receipt: t.state.receipt,
      proof: t.persistedProof, audits: t.state.audits })
    for (let attempt = 1; attempt <= count; attempt++) {
      const correlationId = completeResultRepair(t.remote, `corrective-${attempt}`)
      t.state.repairAttempt = attempt
      t.state.laneCorrelation = correlationId
      t.captureInput.lease!.providerId = t.remote.native!.turnId!
      const source = { type: 'event' as const, event: { executionId: t.execution.id, type: 'turn.started',
        sequence: attempt + 1, occurredAt: t.execution.createdAt,
        payload: { threadId: t.execution.nativeSessionId, turnId: t.remote.native!.turnId!, clientCorrelationId: correlationId } } }
      const evidence = t.channel.capture.capture({ ...t.captureInput, source })
      const capture = t.channel.verify.read(evidence)
      const proof = { ...t.proof, proofId: `correction-${attempt}`, original: capture.source, lane: capture.lane }
      const accepted = await t.freshConnection().transaction(sql =>
        t.helper.resolveOrAdmitLocked(sql, evidence, proof, t.transfer))
      expect(accepted).toEqual({ ...original, context: { ...original.context, turnId: t.remote.native!.turnId } })
    }
    expect({ conversation: t.state.conversation, receipt: t.state.receipt,
      proof: t.persistedProof, audits: t.state.audits }).toEqual(before)
  })

  it('admits and reads context when the lifetime was registered before the provider assigned its session', async () => {
    const t = fixture()
    t.state.expectedReference = null
    const original = await t.admit()
    expect(original.context.nativeSessionId).toBe(t.proof.session.nativeSessionId)
    expect(await t.freshConnection().transaction(sql =>
      t.helper.resolveOrAdmitLocked(sql, t.evidence, t.proof, t.transfer))).toEqual(original)
    expect(t.state.expectedReference).toBeNull()
    expect(t.state.audits).toBe(1)
  })
  it('rejects a lifetime registered for a different native session', async () => {
    const t = fixture()
    t.state.expectedReference = { ...t.proof.session, harness: 'codex', nativeSessionId: 'different-session' }
    await expect(t.admit()).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_CONTEXT_DENIED',
      details: { reason: 'native_lease_changed' } })
    expect(t.state.conversation).toBeUndefined()
  })
  it.each(['missing', 'different'])('rejects an initially unbound lifetime with a %s persisted session', async kind => {
    const t = fixture()
    t.state.expectedReference = null
    t.state.boundSession = kind === 'missing' ? null : { ...t.proof.session,
      harness: 'codex', nativeSessionId: 'different-session' }
    await expect(t.admit()).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    expect(t.state.conversation).toBeUndefined()
    expect(t.state.audits).toBe(0)
  })
  it.each(['reacquired', 'reconnected'])('reads an admitted context with a %s writer lease for the same turn', async kind => {
    const t = fixture()
    const original = await t.connection.transaction(sql =>
      t.helper.resolveOrAdmitLocked(sql, t.evidence, t.proof, t.transfer))
    const receipt = structuredClone(t.state.receipt)
    const proof = structuredClone(t.persistedProof)
    t.captureInput.lease!.fence.token = 'reacquired-lease'
    if (kind === 'reconnected') t.captureInput.lease!.previous.connectionGeneration++
    const evidence = t.channel.capture.capture(t.captureInput)

    const accepted = await t.freshConnection().transaction(sql =>
      t.helper.resolveOrAdmitLocked(sql, evidence, proof, t.transfer))

    expect(accepted).toEqual(original)
    expect(t.persistedProof).toEqual(proof)
    expect(t.state.receipt).toEqual(receipt)
    expect(t.state.audits).toBe(1)
  })
  it.each(['id', 'providerId'] as const)('rejects replay with a different original lane %s', async field => {
    const t = fixture()
    await t.admit()
    const proof = structuredClone(t.proof)
    proof.lane![field] = 'different-original'
    await expect(t.freshConnection().transaction(sql =>
      t.helper.resolveOrAdmitLocked(sql, t.evidence, proof, t.transfer)))
      .rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_CONTEXT_DENIED',
        details: { reason: 'captured_source_changed' } })
    expect(t.state.audits).toBe(1)
  })
  it('durably reads the first admission across two starts, later events, history and a reconstructed helper', async () => {
    const t = fixture(), original = await t.connection.transaction(sql => t.helper.resolveOrAdmitLocked(sql, t.evidence, t.proof, t.transfer))
    const receipt = structuredClone(t.state.receipt), conversation = structuredClone(t.state.conversation)
    for (const type of ['turn.started', 'item.started', 'history'] as const) {
      const input = { ...t.captureInput, source: type === 'history'
        ? { type: 'history' as const, history: { events: [], pendingInteractions: [], nativeTurnId: 'original-turn' } }
        : { type: 'event' as const, event: { executionId: t.execution.id, type, sequence: 2, occurredAt: t.configuration.createdAt,
          payload: { threadId: t.proof.session.nativeSessionId, turnId: 'original-turn' } } } } as WorkflowNativeCaptureInput
      const evidence = t.channel.capture.capture(input), capture = t.channel.verify.read(evidence)
      const proof = { ...t.proof, proofId: `later-${type}`, original: capture.source, observedAt: capture.observedAt, lane: capture.lane }
      const helper = new WorkflowNativeFileContextAdmission(t.mainId, t.ports)
      expect(await t.freshConnection().transaction(sql => helper.resolveOrAdmitLocked(sql, evidence, proof, t.transfer))).toEqual(original)
    }
    expect(t.state.receipt).toEqual(receipt); expect(t.state.conversation).toEqual(conversation); expect(t.state.audits).toBe(1)
    expect(t.retainNativeSource.mock.calls.every(call => call[1] === 'original-proof')).toBe(true)
  })
  it('recovers lost first commit ACK from persisted admission and genuine later start', async () => {
    const t = fixture(); t.state.loseAck = true
    await expect(t.connection.transaction(sql => t.helper.resolveOrAdmitLocked(sql, t.evidence, t.proof, t.transfer))).rejects.toThrow('ACK lost')
    const input = { ...t.captureInput, source: { type: 'event' as const, event: {
      executionId: t.execution.id, type: 'turn.started', sequence: 2, occurredAt: t.configuration.createdAt, payload: { turnId: 'original-turn' } } } }
    const evidence = t.channel.capture.capture(input), capture = t.channel.verify.read(evidence)
    const proof = { ...t.proof, proofId: 'notification-start', original: capture.source, observedAt: capture.observedAt, lane: capture.lane }
    const original = structuredClone(t.state.receipt)
    await t.freshConnection().transaction(sql => new WorkflowNativeFileContextAdmission(t.mainId, t.ports).resolveOrAdmitLocked(sql, evidence, proof, t.transfer))
    expect(t.state.receipt).toEqual(original); expect(t.state.audits).toBe(1)
  })
  it('admits missed first start only from a genuine nonterminal history capture of the original turn', async () => {
    const t = fixture(), input = { ...t.captureInput, source: { type: 'history' as const,
      history: { events: [], pendingInteractions: [], nativeTurnId: 'original-turn' } } } as WorkflowNativeCaptureInput
    const evidence = t.channel.capture.capture(input), capture = t.channel.verify.read(evidence)
    const proof = { ...t.proof, proofId: 'history-proof', original: capture.source, observedAt: capture.observedAt, lane: capture.lane }
    Object.assign(t.persistedProof, proof); t.source.sourceDigest = repeatDigest(proof)
    await t.connection.transaction(sql => t.helper.resolveOrAdmitLocked(sql, evidence, proof, t.transfer))
    expect(t.state.receipt?.result).toMatchObject({ proofId: 'history-proof', sourceDigest: repeatDigest(proof) })
    expect(t.state.audits).toBe(1)
  })
  it.each(['original-proof', 'receipt', 'stopped', 'lane', 'closure', 'revoked', 'physical', 'directory'] as const)(
    'fails closed when persisted first admission loses %s on later readback', async field => {
      const t = fixture(); await t.admit()
      if (field === 'original-proof') t.state.proofAvailable = false
      if (field === 'receipt') t.state.receipt!.input_hash = 'changed'
      if (field === 'stopped') t.state.stopped = true
      if (field === 'lane') t.state.laneLive = false
      if (field === 'closure') t.state.closureLive = false
      if (field === 'revoked') t.state.revoked = true
      if (field === 'physical') t.ports.assertPhysical.mockRejectedValueOnce(new Error('physical unavailable'))
      if (field === 'directory') t.execution.workingDirectory = '/replacement'
      await expect(t.connection.transaction(sql => t.helper.resolveOrAdmitLocked(sql, t.evidence, t.proof, t.transfer))).rejects.toThrow()
      expect(t.state.audits).toBe(1)
    })
  it('rechecks existing context at commit and poisons even a caught replay denial', async () => {
    const t = fixture(); await t.admit(); const receipt = structuredClone(t.state.receipt)
    await expect(t.connection.transaction(async sql => {
      await t.helper.resolveOrAdmitLocked(sql, t.evidence, t.proof, t.transfer)
      t.state.stopped = true
    })).rejects.toThrow()
    expect(t.state.receipt).toEqual(receipt); expect(t.state.audits).toBe(1)
    await expect(t.connection.transaction(async sql => {
      await t.helper.resolveOrAdmitLocked(sql, t.evidence, t.proof, t.transfer).catch(error => {
        expect(error).toBeInstanceOf(DomainError)
      })
    })).rejects.toMatchObject({ code: 'GRAPH_TRANSACTION_FAILED' })
  })
  it('admits one namespaced conversation and exact native context in the capture transaction, then resolves it', async () => {
    const t = fixture(), accepted = await t.admit()
    expect(accepted.attempt).toEqual(t.attempt)
    expect(accepted.context).toMatchObject({ ownerPrincipalId: 'run-owner', nativeSessionId: 'original-session', turnId: 'original-turn', allowMutation: true })
    expect(accepted.context.messageId).toBeUndefined(); expect(accepted.context.nativeMessageId).toBeUndefined()
    expect(t.state.conversation?.key).toBe(workflowNativeFileConversationKey(t.mainId, t.execution.id, t.intent.attemptId))
    expect(t.state.receipt?.result).toMatchObject({ commandId: t.proof.commandId, proofId: t.proof.proofId,
      session: t.proof.session, workingDirectory: '/original/worktree', runtimeDirectory: '/original/runtime' })
    expect(JSON.stringify(t.state.conversation)).not.toContain('unit-lease')
    expect(t.ports.assertPhysical).toHaveBeenCalledTimes(2); expect(t.state.audits).toBe(1)
    expect(t.retainNativeSource).toHaveBeenCalledWith(expect.anything(), t.proof.proofId)
    expect(await t.connection.transaction(sql => t.authority.resolveWorkflowContext(t.attempt, t.transfer, sql))).toEqual(accepted)
    expect(t.state.boundSession).toEqual(t.proof.session)
    expect(t.state.conversation?.record).toMatchObject({ origin: { kind: 'run_execution',
      runId: t.execution.runId, executionId: t.execution.id, sourceNativeSessionId: t.proof.session.nativeSessionId } })
  })
  it('keeps human chat key namespaces distinct and never adopts an existing human or conflicting internal conversation', async () => {
    const t = fixture(), context = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent', runId: 'run' }
    const key = workflowNativeFileConversationKey(t.mainId, t.execution.id, t.intent.attemptId)
    expect(key).not.toBe(agentChatKey(context)); expect(key).not.toBe(runChatStorageKey(context, t.execution.id))
    t.state.conversation = { id: 'human-chat', key: runChatStorageKey(context, t.execution.id), record: { origin: { kind: 'fresh' } } }
    await expect(t.admit()).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_CONTEXT_CONFLICT' })
    expect(t.state.conversation.id).toBe('human-chat'); expect(t.state.receipt).toBeUndefined()
  })
  it('replays exact context after reconstruction or lost commit ACK without another conversation or audit', async () => {
    const t = fixture(); t.state.loseAck = true
    await expect(t.admit()).rejects.toThrow('ACK lost')
    const original = structuredClone(t.state.receipt!)
    const restored = new WorkflowNativeFileContextAdmission(t.mainId, t.ports), connection = t.freshConnection()
    const accepted = await connection.transaction(sql => restored.admitLocked(sql, t.evidence, t.proof, t.transfer))
    expect(accepted.context).toMatchObject({ nativeSessionId: 'original-session', turnId: 'original-turn' })
    expect(t.state.receipt).toEqual(original)
    expect(t.state.audits).toBe(1); expect(t.state.commits).toBe(2)
  })
  it('idempotently returns the same accepted context on the exact original capture/command retry', async () => {
    const t = fixture(), original = await t.admit()
    const helper = new WorkflowNativeFileContextAdmission(t.mainId, t.ports)
    expect(await t.connection.transaction(sql => helper.admitLocked(sql, t.evidence, t.proof, t.transfer))).toEqual(original)
    expect(t.state.audits).toBe(1); expect(t.state.commits).toBe(2)
  })
  it.each(['serialized', 'foreign', 'boundary', 'session'] as const)('denies %s evidence before context insertion', async field => {
    const t = fixture()
    let evidence = t.evidence
    if (field === 'serialized') evidence = structuredClone(evidence)
    if (field === 'foreign') evidence = createWorkflowNativeCaptureChannel().capture.capture(t.captureInput)
    if (field === 'boundary') evidence = t.channel.capture.capture({ ...t.captureInput, source: { type: 'boundary' } })
    if (field === 'session') {
      const input = { ...t.captureInput, source: { type: 'session_created' as const, session: t.proof.session } }
      delete input.lease
      evidence = t.channel.capture.capture(input)
    }
    await expect(t.admit(evidence)).rejects.toBeInstanceOf(DomainError)
    expect(t.state.conversation).toBeUndefined(); expect(t.state.receipt).toBeUndefined()
  })
  it.each(['proof', 'command', 'directory', 'config', 'owner', 'lifetime', 'lease', 'lane', 'closure', 'grant', 'stopped'] as const)(
    'denies missing or changed %s without context admission', async field => {
      const t = fixture(), proof = structuredClone(t.proof)
      if (field === 'proof') t.state.proofAvailable = false
      if (field === 'command') proof.commandId = 'another-command'
      if (field === 'directory') t.execution.workingDirectory = '/replacement'
      if (field === 'config') t.configuration.id = 'replacement'
      if (field === 'owner') t.state.revoked = true
      if (field === 'lifetime') t.state.resident = false
      if (field === 'lease') t.state.leaseHeld = false
      if (field === 'lane') t.state.laneLive = false
      if (field === 'closure') t.state.closureLive = false
      if (field === 'grant') t.state.grantLive = false
      if (field === 'stopped') t.state.stopped = true
      await expect(t.admit(t.evidence, proof)).rejects.toThrow()
      expect(t.state.conversation).toBeUndefined(); expect(t.state.receipt).toBeUndefined(); expect(t.state.audits).toBe(0)
    })
  it.each(['authority', 'owner', 'closure', 'canonical', 'stopped'] as const)('rolls back if %s proof is lost at COMMIT', async field => {
    const t = fixture()
    await expect(t.admit(t.evidence, t.proof, async () => {
      if (field === 'authority') t.state.revoked = true
      if (field === 'owner') t.state.ownerFence = '2'
      if (field === 'closure') t.state.closureLive = false
      if (field === 'canonical') t.state.canonical = false
      if (field === 'stopped') t.state.stopped = true
    })).rejects.toThrow()
    expect(t.state.conversation).toBeUndefined(); expect(t.state.receipt).toBeUndefined(); expect(t.state.audits).toBe(0)
    expect(t.state.commits).toBe(0)
    expect(t.state.conversation).toBeUndefined()
    expect(t.state.receipt).toBeUndefined()
  })
  it('poisons the transaction when a caught denial would otherwise permit COMMIT', async () => {
    const t = fixture(); t.state.proofAvailable = false
    await expect(t.connection.transaction(async sql => {
      await t.helper.admitLocked(sql, t.evidence, t.proof, t.transfer).catch(error => {
        expect(error).toBeInstanceOf(DomainError)
      })
    })).rejects.toMatchObject({ code: 'GRAPH_TRANSACTION_FAILED' })
    expect(t.state.commits).toBe(0)
    expect(t.state.conversation).toBeUndefined()
    expect(t.state.receipt).toBeUndefined()
  })
  it('preserves exact saved read-only sandbox tools and rejects changed native/context receipt retry', async () => {
    const t = fixture(); t.configuration.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'read-only' }
    const accepted = await t.admit()
    expect(accepted.context).toMatchObject({ allowMutation: false, allowedTools: ['files.list', 'files.read'] })
    t.state.receipt!.result = { changed: true }
    await expect(t.admit()).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_CONTEXT_CONFLICT' })
    expect(t.state.audits).toBe(1)
  })
  it('rejects an unbranded query and a missing physical/G1 verifier without partial admission', async () => {
    const t = fixture()
    await expect(t.helper.admitLocked({ query: async () => ({ rows: [] }) } as unknown as GraphTransactionSql, t.evidence, t.proof, t.transfer)).rejects.toThrow()
    t.ports.assertPhysical.mockRejectedValueOnce(new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'unavailable', 409))
    await expect(t.admit()).rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
    vi.mocked(currentRunGraphPublication).mockImplementationOnce(() => { throw new DomainError('GRAPH_SCOPE_MISMATCH', 'unavailable', 409) })
    await expect(t.admit()).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
    expect(t.state.conversation).toBeUndefined(); expect(t.state.receipt).toBeUndefined()
    expect(WORKFLOW_NATIVE_FILE_CONTEXT_OPERATION).toBe('remote.native-artifact.context')
  })
})
