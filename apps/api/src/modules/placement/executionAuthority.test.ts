import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { AgentPlacementProducer } from './agentProducer.js'
import { deriveDispatch, freezePlacement } from './binding.js'
import { approvalFixture } from '../../../test/helpers/wave25ApprovalFixture.js'
import type { RemoteOperationReceipt, RemoteOwnerControl } from '@foreman-code/contracts/remote-execution'
import type pg from 'pg'
import { ExecutionFactsResultSchema } from '@foreman-code/contracts/execution-authority'
import { configurationWithNodeSkills } from '../skills/nodeSkills.js'
import { assertRemoteExecutionAuthority, createExecutionAuthorityExtension } from './executionAuthority.js'
import { ChatSendRequestSchema, WorkflowControlContinuationSchema } from '@foreman-code/contracts'

type ExecutionFactsResult = ReturnType<typeof ExecutionFactsResultSchema.parse>

const ports = vi.hoisted(() => ({ intent: vi.fn(), placement: vi.fn(), native: vi.fn(), installation: vi.fn(), principal: vi.fn() }))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: ports.intent }))
vi.mock('./persistence.js', () => ({ readExecutionPlacement: ports.placement, readNativePlacement: ports.native }))
vi.mock('../devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: ports.installation }))
vi.mock('../access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: ports.principal }))

function fixture() {
  const mainId = randomUUID()
  const digest = 'a'.repeat(64)
  const registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId, deviceId: randomUUID() }, registration,
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex',
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
      installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: 'execution', operationId: 'operation', attemptId: 'attempt',
    technicalAttempt: 1, occurrenceId: null, occurrenceIndex: 0, inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } })
  if (placement.hostRef.kind !== 'device') throw new Error('Expected device placement')
  const connection = { mainId, deviceId: placement.hostRef.deviceId, ...registration,
    bootId: randomUUID(), connectionGeneration: 1 }
  const state = { grant: true, origin: connection, cleanup: false, failedExecutionId: undefined as string | undefined,
    stopped: false, receipt: true, reviewer: undefined as unknown, reviewsPending: false, configuration: undefined as ExecutionFactsResult['configuration'] | undefined,
    harness: undefined as ExecutionFactsResult['harness'] | undefined, version: approvalFixture().version,
    continuation: undefined as unknown, command: undefined as unknown, completedStop: false }
  const receipt: RemoteOperationReceipt = { schemaVersion: 1, intent, connection, workerIncarnationId: randomUUID(), sequence: 4,
    phase: 'running', entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [],
    turnInput: { correlationId: 'execution:execution', promptDigest: digest, sessionMode: 'regular' },
    native: { sessionId: 'native-session', turnId: 'original-turn', processIdentityDigest: digest } }
  let reads = 0
  const sql = { query: async (text: string) => {
    reads++
    if (text.includes('from run_control_continuations')) return {
      rows: state.continuation ? [{ record: state.continuation,
        reserved_successor_execution_id: 'successor', delivery_id: 'delivery' }] : [], rowCount: 0 }
    if (text.includes('from run_chat_commands')) return {
      rows: state.command ? [state.command] : state.completedStop ? [{ id: 'stop' }] : [], rowCount: 0 }
    if (text.includes('source_preparation_reconciliations')) return { rows: [], rowCount: 0 }
    if (text.startsWith('select i.record as dispatch')) return { rows: [{ dispatch: intent, transition: null,
      placement, operation_id: intent.operationId, execution_id: intent.executionId, run_id: intent.runId,
      node_id: intent.nodeId, binding_hash: intent.bindingHash, attempt_id: intent.attemptId,
      authorization_principal_id: 'principal', workspace_id: 'workspace', workflow_id: 'workflow',
      execution_state: 'running', stopped: state.stopped, cleanup: state.cleanup,
      failed: state.failedExecutionId === intent.executionId, granted: state.grant,
      connection: state.origin, receipt: state.receipt ? receipt : null, receipt_present: state.receipt, entered: true }], rowCount: 1 }
    if (text.startsWith('select r.record as run')) return { rows: state.reviewer ? [state.reviewer] : [],
      rowCount: state.reviewer ? 1 : 0 }
    if (text.includes('agent_configuration_versions')) return { rows: [{ record: state.configuration, version: state.version }], rowCount: 1 }
    if (text.includes('workflow_versions')) return { rows: [{ record: state.version }], rowCount: 1 }
    if (text.startsWith('select 1 from review_jobs')) return { rows: state.reviewsPending ? [{}] : [],
      rowCount: state.reviewsPending ? 1 : 0 }
    if (text.includes('from runs r')) return { rows: [{ authorization_principal_id: 'principal', workspace_id: 'workspace',
      workflow_id: 'workflow', execution_state: 'running', stopped: state.stopped, cleanup: state.cleanup,
      failed: state.failedExecutionId === intent.executionId }], rowCount: 1 }
    if (text.includes('execution_dispatch_owner_grants')) return { rows: [], rowCount: state.grant ? 1 : 0 }
    if (text.includes('remote_dispatch_origins')) return { rows: [{ connection: state.origin }], rowCount: 1 }
    if (text.includes('remote_execution_receipts')) return { rows: state.receipt ? [{ receipt }] : [], rowCount: state.receipt ? 1 : 0 }
    return { rows: [], rowCount: 1 }
  } } as unknown as GraphTransactionSql
  const locations = { revalidateRunAuthorization: vi.fn(async () => {}) }
  const pins = vi.fn<AgentPlacementProducer['assertPinsCurrent']>(async () => {})
  const producer = { assertPinsCurrent: pins, harnessFacts: async () => state.harness } as unknown as AgentPlacementProducer
  ports.intent.mockResolvedValue(intent)
  ports.placement.mockResolvedValue(placement)
  ports.native.mockResolvedValue({})
  ports.installation.mockResolvedValue(registration)
  ports.principal.mockResolvedValue({ id: 'principal' })
  const authorize = (action: 'start' | 'read' | 'control' | 'stop', authenticated = connection) =>
    assertRemoteExecutionAuthority(sql, locations, { version: 1, intent, placement, action }, authenticated, producer)
  const client = { query: (input: string | pg.QueryConfig, values?: unknown[]) =>
    sql.query(typeof input === 'string' ? input : input.text, typeof input === 'string' ? values : input.values),
  on() {}, removeListener() {}, release() {} }
  const extension = createExecutionAuthorityExtension({ connect: async () => client } as unknown as pg.Pool,
    locations, producer)
  const request = (action: 'read' | 'control' | 'stop' | 'retain-reviewer' = 'read', workflowControl?: RemoteOwnerControl) => extension.handle!(
    { version: 1, intent, placement, action, ...(workflowControl ? { workflowControl } : {}) },
    { binding: connection } as Parameters<NonNullable<typeof extension.handle>>[1])
  const readFacts = () => extension.handle!({ method: 'read-facts',
    authorization: { version: 1, intent, placement, action: 'read' } },
  { binding: connection } as Parameters<NonNullable<typeof extension.handle>>[1])
  return { authorize, state, locations, pins, connection, intent, placement, receipt, request, readFacts, reads: () => reads }
}


function retainReviewer(f: ReturnType<typeof fixture>) {
  const saved = approvalFixture()
  const execution = { ...saved.executions[0]!, id: f.intent.executionId, runId: f.intent.runId,
    workflowNodeId: f.intent.nodeId, nativeSessionId: f.receipt.native!.sessionId,
    state: 'completed' as const, finishedAt: '2026-10-01T00:00:00.000Z',
    result: { outcome: 'succeeded' as const } }
  saved.version.entryNodeId = f.intent.nodeId
  saved.version.definition.entryNodeId = f.intent.nodeId
  saved.version.definition.nodes[0]!.id = f.intent.nodeId
  for (const edge of saved.version.definition.edges) edge.source = f.intent.nodeId
  const reviewer = { run: { ...saved.run, id: f.intent.runId }, version: saved.version,
    execution, configuration: saved.configurations[0], finalized: true,
    reference: { harness: 'codex', providerVersion: 'fixture', nativeSessionId: f.receipt.native!.sessionId } }
  f.state.reviewer = reviewer
  f.receipt.retainedReviewer = { agentId: execution.agentId, workflowTurnId: f.receipt.native!.turnId!,
    result: execution.result, expiresAt: '2026-10-01T00:01:00.000Z' }
  return reviewer
}

describe('Main reviewer retention after workflow controls', () => {
  it('offers the successful ordinary reviewer without changing its original result or native identity', async () => {
    const f = fixture()
    const reviewer = retainReviewer(f)
    const original = structuredClone({ reviewer, receipt: f.receipt })
    await expect(f.request('retain-reviewer')).resolves.toMatchObject({
      payload: { reviewer: { agentId: reviewer.execution.agentId } },
    })
    expect({ reviewer, receipt: f.receipt }).toEqual(original)
  })

  it.each(['reserved', 'waiting_settlement', 'admitted', 'failed', 'canceled', 'unknown'] as const)(
    'withholds retention for a %s continuation across repeated authority reads', async state => {
      const f = fixture()
      const reviewer = retainReviewer(f)
      const previousExecution = { runId: f.intent.runId, workflowVersionId: reviewer.version.id,
        executionId: f.intent.executionId, attempt: 1 }
      const target = { kind: 'workflow_execution', execution: previousExecution,
        agent: { workspaceId: reviewer.run.workspaceId, workflowId: reviewer.run.workflowId,
          workflowNodeId: f.intent.nodeId, agentId: reviewer.execution.agentId } }
      f.state.command = { request: ChatSendRequestSchema.parse({ commandId: 'send', target,
        intent: 'interrupt_and_send', content: 'Revise the work', attachments: [] }) }
      f.state.continuation = WorkflowControlContinuationSchema.parse({ id: 'continuation',
        controlCommandId: 'send', deliveryReceiptId: 'delivery',
        work: { kind: 'slot', runId: f.intent.runId, workflowVersionId: reviewer.version.id, slotId: 'slot' },
        previousExecution, nativeTarget: { nativeSessionId: f.receipt.native!.sessionId,
          nativeTurnId: f.receipt.native!.turnId, ownerRequestId: `execution:${f.intent.executionId}` },
        cause: 'interrupt_and_send', state,
        successorExecution: state === 'admitted' ? { ...previousExecution, executionId: 'successor', attempt: 2 } : null,
        errorCode: state === 'failed' ? 'PREPARATION_FAILED' : null,
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })
      const original = structuredClone({ reviewer, receipt: f.receipt })
      for (let read = 0; read < 2; read++) {
        const response = await f.request('retain-reviewer')
        expect(response.payload).not.toHaveProperty('reviewer')
      }
      expect({ reviewer, receipt: f.receipt }).toEqual(original)
    },
  )

  it('withholds retention after an unqueued Stop receipt has completed', async () => {
    const f = fixture()
    const reviewer = retainReviewer(f)
    f.state.completedStop = true
    const original = structuredClone({ reviewer, receipt: f.receipt })
    const response = await f.request('retain-reviewer')
    expect(response.payload).not.toHaveProperty('reviewer')
    expect({ reviewer, receipt: f.receipt }).toEqual(original)
  })

  it.each(['failed', 'canceled'] as const)('withholds retention after normalized %s', async outcome => {
    const f = fixture()
    const reviewer = retainReviewer(f)
    const result = outcome === 'failed'
      ? { outcome, error: { code: 'WORKFLOW_RESULT_REJECTED', message: 'The workflow result was rejected.', retryable: false } }
      : { outcome }
    f.state.reviewer = { ...reviewer, execution: { ...reviewer.execution, result } }
    const response = await f.request('retain-reviewer')
    expect(response.payload).not.toHaveProperty('reviewer')
  })
})

describe('Main authority for admitted workflow controls', () => {
  it.each(['stop', 'steer'] as const)('authorizes only the durable %s command and its original native input', async kind => {
    const f = fixture()
    const command: RemoteOwnerControl = { schemaVersion: 1, protocolVersion: 1, commandId: 'chat-control',
      operationId: f.intent.operationId, attemptId: f.intent.attemptId, executionId: f.intent.executionId,
      bindingHash: f.intent.bindingHash, owner: f.intent.owner, native: f.receipt.native!,
      workflowControl: { ownerRequestId: 'execution:execution' },
      action: kind === 'stop' ? { kind } : { kind, prompt: 'Revise the current plan.' } }
    const target = { kind: 'workflow_execution', agent: { workspaceId: 'workspace', workflowId: 'workflow',
      workflowNodeId: 'node', agentId: 'agent' }, execution: { runId: 'run', workflowVersionId: 'version', executionId: 'execution', attempt: 1 } }
    const stored = { id: command.commandId, run_id: 'run', target, state: 'unknown', operation: kind,
      native_target: { nativeSessionId: 'native-session', nativeTurnId: 'original-turn',
        ownerRequestId: 'execution:execution', sessionMode: 'plan' },
      request: { target, intent: 'steer', content: 'Revise the current plan.', attachments: [], sessionMode: 'plan' },
      native_prompt: 'Revise the current plan.' }
    f.state.command = stored
    const action = kind === 'stop' ? 'stop' : 'control'
    await expect(f.request(action, command)).resolves.toMatchObject({ payload: { workflowControlCommandId: 'chat-control' } })
    await expect(f.request(action, { ...command, workflowControl: { ownerRequestId: 'execution:other' } }))
      .rejects.toMatchObject({ code: 'REMOTE_CONTROL_UNAVAILABLE' })
    await expect(f.request(action, { ...command, native: { ...command.native!, turnId: 'later-turn' } }))
      .rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    f.state.command = { ...stored, state: 'canceled' }
    await expect(f.request(action, command)).rejects.toMatchObject({ code: 'REMOTE_CONTROL_UNAVAILABLE' })
    f.state.command = stored
    f.state.grant = false
    await expect(f.request(action, command)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })
})

describe('remote cleanup authorization', () => {
  it('lets the Worker stop and read back only the failed attempt while retaining its owner and device checks', async () => {
    const f = fixture()
    f.state.failedExecutionId = f.intent.executionId
    await expect(f.authorize('stop')).resolves.toEqual({ cleanupOnly: true })
    await expect(f.request('stop')).resolves.toMatchObject({ payload: { action: 'stop', cleanupOnly: true } })
    await expect(f.request('read')).resolves.toMatchObject({ payload: { action: 'read', cleanupOnly: true } })
    expect(f.state.cleanup).toBe(false)
    f.state.failedExecutionId = 'sibling-execution'
    await expect(f.request('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    f.state.failedExecutionId = f.intent.executionId
    f.state.grant = false
    await expect(f.request('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    f.state.grant = true
    ports.installation.mockResolvedValue({ authorizationRevision: 2, keyRevision: 1 })
    await expect(f.request('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })

  it.each(['permission', 'source', 'root', 'harness'])('keeps Stop and closure readback after %s invalidation', async defect => {
    const f = fixture()
    f.state.cleanup = true
    f.state.stopped = true
    if (defect === 'permission') f.locations.revalidateRunAuthorization.mockRejectedValue(new Error('Permission revoked'))
    else f.pins.mockRejectedValue(new Error(`${defect} changed`))
    await expect(f.authorize('start')).rejects.toThrow()
    await expect(f.authorize('control')).rejects.toThrow()
    await expect(f.authorize('stop')).resolves.toEqual({ cleanupOnly: true })
    await expect(f.authorize('read')).resolves.toEqual({ cleanupOnly: true })
  })

  it('authorizes closure of a successful idle reviewer while preserving live Run grants', async () => {
    const f = fixture()
    retainReviewer(f)
    await expect(f.authorize('stop')).resolves.toBeUndefined()
    expect(f.locations.revalidateRunAuthorization).toHaveBeenCalled()
    expect(f.pins).toHaveBeenCalled()
    f.state.reviewsPending = true
    await expect(f.authorize('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    f.state.reviewsPending = false
    f.locations.revalidateRunAuthorization.mockRejectedValue(new Error('Permission revoked'))
    await expect(f.authorize('stop')).rejects.toThrow('Permission revoked')
  })

  it('keeps successful reviewer closure tied to session finalization and its live owner grant', async () => {
    const f = fixture()
    const reviewer = retainReviewer(f)
    await expect(f.authorize('stop')).resolves.toBeUndefined()
    reviewer.finalized = false
    await expect(f.authorize('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    reviewer.finalized = true
    f.state.grant = false
    await expect(f.authorize('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })

  it('requires a committed cleanup intent even when the caller holds the original grant', async () => {
    const f = fixture()
    await expect(f.authorize('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    expect(f.locations.revalidateRunAuthorization).not.toHaveBeenCalled()
  })

  it.each(['owner-grant', 'dispatch-owner', 'registration', 'device'])('preserves the %s fence during cleanup', async defect => {
    const f = fixture()
    f.state.cleanup = true
    if (defect === 'owner-grant') f.state.grant = false
    if (defect === 'dispatch-owner') ports.intent.mockResolvedValue({ ...f.intent, owner: { grantId: 'other', epoch: '2' } })
    if (defect === 'registration') ports.installation.mockResolvedValue({ authorizationRevision: 2, keyRevision: 1 })
    const authenticated = { ...f.connection }
    if (defect === 'device') authenticated.deviceId = randomUUID()
    await expect(f.authorize('stop', authenticated)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })
})

describe('authenticated original execution reconnection', () => {
  it('keeps the original owner authority on a transport-only replacement channel of the same boot', async () => {
    const f = fixture()
    const replacement = { ...f.connection, connectionGeneration: 2 }
    await expect(f.authorize('read', replacement)).resolves.toBeUndefined()
    await expect(f.authorize('control', replacement)).resolves.toBeUndefined()
    expect(f.pins.mock.calls.at(-1)?.[4]).toEqual({ purpose: 'resident' })
    await expect(f.authorize('start', replacement)).resolves.toBeUndefined()
    f.state.cleanup = true
    await expect(f.authorize('stop', replacement)).resolves.toEqual({ cleanupOnly: true })
    expect(f.receipt.connection).toEqual(f.connection)
  })

  it('keeps an unacknowledged preparation authorized after the same Worker boot reconnects', async () => {
    const f = fixture()
    f.state.receipt = false
    const replacement = { ...f.connection, connectionGeneration: 2 }
    await expect(f.authorize('start', replacement)).resolves.toBeUndefined()
    await expect(f.authorize('control', replacement)).resolves.toBeUndefined()
    expect(f.pins.mock.calls.at(-1)?.[4]).toBeUndefined()
    const restarted = { ...replacement, bootId: randomUUID() }
    for (const action of ['start', 'control'] as const) {
      await expect(f.authorize(action, restarted)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    }
  })

  it.each(['native', 'owner', 'origin'])('requires retained original %s evidence before reconnecting control', async defect => {
    const f = fixture()
    if (defect === 'native') delete (f.receipt as { native?: unknown }).native
    if (defect === 'owner') f.receipt.intent = { ...f.intent, owner: { grantId: 'other', epoch: '2' } }
    if (defect === 'origin') f.receipt.connection = { ...f.connection, connectionGeneration: 2 }
    const replacement = { ...f.connection, connectionGeneration: 2 }
    await expect(f.authorize('read', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    await expect(f.authorize('control', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })

  it('reads an acknowledged owner after an OS restart without authorizing continuation or new entry', async () => {
    const f = fixture()
    const restarted = { ...f.connection, bootId: randomUUID(), connectionGeneration: 2 }
    f.pins.mockRejectedValue(new Error('New OS has no current launch qualification'))
    await expect(f.authorize('read', restarted)).resolves.toBeUndefined()
    expect(f.locations.revalidateRunAuthorization).toHaveBeenCalled()
    expect(f.pins).not.toHaveBeenCalled()
    for (const action of ['control', 'start', 'stop'] as const) {
      await expect(f.authorize(action, restarted)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    }
    f.state.cleanup = true
    await expect(f.authorize('stop', restarted)).resolves.toEqual({ cleanupOnly: true })
    delete (f.receipt as { native?: unknown }).native
    await expect(f.authorize('read', restarted)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })

  it('can consult the original worker journal from a restarted Worker when Main lost the preparation acknowledgment', async () => {
    const f = fixture()
    f.state.receipt = false
    const replacement = { ...f.connection, bootId: randomUUID(), connectionGeneration: 2 }
    f.pins.mockRejectedValue(new Error('This channel cannot qualify a new launch'))
    await expect(f.authorize('read', replacement)).resolves.toBeUndefined()
    expect(f.locations.revalidateRunAuthorization).toHaveBeenCalled()
    expect(f.pins).not.toHaveBeenCalled()
    await expect(f.authorize('control', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    await expect(f.authorize('start', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    f.state.cleanup = true
    await expect(f.authorize('stop', replacement)).resolves.toEqual({ cleanupOnly: true })
    f.state.grant = false
    await expect(f.authorize('read', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })
})


describe('remote execution authority reads', () => {
  it('returns the original persisted authority with a bounded number of database reads', async () => {
    const f = fixture()
    const before = structuredClone(f.receipt)
    const result = await f.request()
    expect(result).toEqual({ payload: { version: 1, action: 'read', operationId: f.intent.operationId,
      attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, owner: f.intent.owner } })
    expect(f.receipt).toEqual(before)
    // Includes transaction open and close plus two fresh authority snapshots.
    expect(f.reads()).toBeLessThanOrEqual(4)
  })

  it('rejects a grant revoked between the initial read and the commit check', async () => {
    const f = fixture()
    f.pins.mockImplementationOnce(async () => { f.state.grant = false })
    await expect(f.request()).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })

  it('preserves cleanup-only reads without accepting revoked owner grants', async () => {
    const f = fixture()
    f.state.cleanup = true
    expect(await f.request()).toMatchObject({ payload: { cleanupOnly: true } })
    expect(f.pins).not.toHaveBeenCalled()
    f.state.grant = false
    await expect(f.request()).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })
})


it('returns the same effective node skill configuration that the execution sends to the Worker', async () => {
  const f = fixture()
  const facts = factsFixture(f)
  f.state.harness = facts.harness
  ports.native.mockResolvedValue(facts.executionPlacement)
  const pinned = { ...facts.configuration, assignedSkills: [{ skillId: 'base-skill', version: '1' }],
    resolvedSkills: [{ skillId: 'base-skill', version: '1', name: 'Base', instructions: 'Base instructions.',
      contentHash: `sha256:${createHash('sha256').update('Base instructions.').digest('hex')}` }] }
  const skills = { remove: ['base-skill'] }
  f.state.configuration = pinned
  f.state.version.entryNodeId = f.intent.nodeId
  f.state.version.definition.entryNodeId = f.intent.nodeId
  f.state.version.definition.nodes = [{ id: f.intent.nodeId, agentId: pinned.agentId, name: 'Worker', skills }]
  f.state.version.definition.edges = []
  f.state.version.agentConfigurationVersionIds = { [pinned.agentId]: pinned.id }
  const expected = configurationWithNodeSkills(pinned, skills)
  const response = await f.readFacts()
  expect(ExecutionFactsResultSchema.parse(response.payload).configuration).toEqual(expected)
  expect(pinned.assignedSkills).toHaveLength(1)
})

function factsFixture(f: ReturnType<typeof fixture>): ExecutionFactsResult {
  const at = '2026-10-01T00:00:00.000Z'
  const hash = 'a'.repeat(64)
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const configuration = { ...approvalFixture().configurations[0]!, id: 'configuration', agentId: 'agent' }
  const target = { hostRef: f.placement.hostRef, applicationInstallationId: f.connection.workerInstallationId,
    harnessInstallationId: 'harness', installationFingerprint: hash }
  const materializationId = randomUUID()
  return ExecutionFactsResultSchema.parse({ version: 1, intent: f.intent, placement: f.placement, configuration,
    executionPlacement: { version: 1, acceptedBindingHash: f.placement.bindingHash, bindingHash: hash,
      runId: f.intent.runId, nodeId: f.intent.nodeId, executionId: f.intent.executionId,
      attemptId: f.intent.attemptId, operationId: f.intent.operationId,
      materialization: { rootPolicyId: 'policy', rootPolicyRevision: '1', operationId: f.intent.operationId,
        reservationId: randomUUID(), sourceBindingHash: hash, finalDispatchBindingHash: hash, state: 'prepared',
        receipt: { version: 1, materializationId, placementHash: hash,
          executionId: f.intent.executionId, attemptId: f.intent.attemptId, keyRevision: 1, authorizationRevision: 1,
          verifiedManifestDigest: hash, verifiedEntries: 0, verifiedBytes: 0, verifiedAt: at, localTreeIdentity: filesystem,
          binding: { version: 1, mainId: f.connection.mainId, deviceId: f.connection.deviceId,
            workerInstallationId: f.connection.workerInstallationId, workspaceId: configuration.workspaceId,
            rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: '/project', filesystem,
            accessMode: 'read-only', snapshotId: randomUUID(), manifestDigest: hash } } },
      workingTree: { materializationId, materializationDigest: hash, canonicalProjectRoot: '/project',
        canonicalCwd: '/project', directoryIdentityHash: hash, filesystem, accessMode: 'read-only', privateGit: null } },
    harness: {
      override: { instanceId: randomUUID(), revision: 1, instanceRevision: '1', target, presetId: 'fixture',
        enabled: true, driverId: 'codex', configuration: configuration.harness,
        configurationFingerprint: hash, qualification: 'qualified' },
      profileProof: { target, instanceRevision: '1', configurationFingerprint: hash, driverId: 'codex',
        driverRevision: '1', protocolRevision: '1', suiteRevision: 'fixture', environmentGeneration: '1',
        connectionGeneration: '1', authenticated: true, compatible: true, qualified: true, checkedAt: at },
      qualification: { harness: 'codex', version: '0.154.0', binarySha256: hash, status: 'qualified',
        profile: 'codex-0.154', suiteRevision: 'fixture', checks: [], failureReason: null, startedAt: at, checkedAt: at },
      installation: { hostRef: f.placement.hostRef, harnessInstallationId: 'harness', installationFingerprint: hash,
        driverId: 'codex', driverRevision: '1', protocolRevision: '1', environmentGeneration: '1', connectionGeneration: '1',
        observedVersion: '0.154.0', installed: true, authenticated: true, compatible: true, qualified: true,
        launcher: { requested: '/installed/codex', resolvedLauncher: '/installed/codex', fingerprint: hash,
          payloadFingerprints: [], status: 'installed', interpreter: null, diagnostics: [], checkedAt: at,
          environment: { generation: '1', provenance: 'worker', cwd: '/project', path: '/usr/bin' } } },
    } })
}
