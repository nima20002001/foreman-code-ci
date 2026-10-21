import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { HarnessExecutionSchema, DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES, type DurableInteraction, type HarnessExecution } from '@foreman-code/contracts'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { decisionDigest } from '../src/modules/interactions/wave25/publication.js'
import { settleRepeatNativeExecutionLocked } from '../src/modules/interactions/repeatNativeSettlement.js'
import { nativeAt, nativeCompleted, nativeFixture } from './eng04-native-fixtures.js'
import { canonicalRepeatEffectReceipt } from '../src/modules/run-graph/repeatPublication.js'
import { bindRepeatNodeInput, repeatDigest, repeatExecutionIdentity, repeatSlotId } from '../src/modules/runs/repeatResolution.js'
import { workflowNativeReservation, type WorkflowNativeReservation } from '../src/modules/runs/workflowNativeEntry.js'
import { currentUnitSnapshot, currentUnitRunRow, currentUnitVersionRow, currentUnitConfigurationRows,
  type CurrentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

// These local-owner cases use the real closure reader; remote retention is a separate domain boundary.
vi.mock('../src/modules/interactions/retainedRemoteReviewer.js', () => ({
  readRetainedRemoteReviewer: async () => undefined,
  retainRemoteReviewerCredential: async () => { throw new Error('Local settlement cannot retain a remote credential') },
}))

/** A scripted pg-shaped transaction, NOT a PostgreSQL/native integration test.
 * It executes the real settlement and readWorkflowClosure functions. Unknown
 * queries fail rather than returning empty rows, so newly added gates require
 * an explicit fixture update. No fake Worker acknowledgement is written. */
class NativePgShape {
  readonly fixture = nativeFixture()
  execution = nativeCompleted(this.fixture.execution)
  semantics = '3'
  negativeCleanup = false
  session = { harness: 'codex' as const, providerVersion: '0.154.0', nativeSessionId: this.execution.nativeSessionId! }
  hasSession = true
  finalized = false
  hasClosure = true
  generation = '17'
  priorUnclosed = false
  closed = true
  closureIdentity: Record<string, unknown> | null = null
  replaceGenerationOnSecondRead = false
  closureReads = 0
  resourcesOutstanding = false
  entryFixture: CurrentUnitSnapshot | undefined
  entryReservation: WorkflowNativeReservation | undefined
  entryPhase: 'reserved' | 'prepared' | 'entered' | null = 'reserved'
  bindingDigest = ''
  configurationPinned = true
  updateCount = 0
  casMatches = true
  interactions: Array<{ value: DurableInteraction; retired: boolean }> = []
  resume: { state: string; approval_native_ack_id: string | null } | null = { state: 'resumed', approval_native_ack_id: 'real-history-ack' }
  resumeDigest: string | null = null
  readonly calls: string[] = []
  readonly reviewerRows: Array<Record<string, unknown>> = []

  identity(execution: HarnessExecution) {
    return { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
      agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
      attempt: execution.attempt,
      ...(execution.workingDirectory ? { workingDirectory: execution.workingDirectory } : {}),
      ...(execution.runtimeDirectory ? { runtimeDirectory: execution.runtimeDirectory } : {}) }
  }
  async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const q = text.replace(/\s+/g, ' ').trim()
    this.calls.push(q)
    const rows = (result: unknown[]) => ({ rows: result, rowCount: result.length })
    if (q.startsWith('begin ') || q === 'commit' || q === 'rollback') return rows([])
    if (q.startsWith("select id,record->>'executionSemanticsVersion'")) {
      expect(values).toEqual([this.execution.runId])
      return rows([{ id: this.execution.runId, semantics: this.semantics, workspace_id: this.fixture.scope.workspaceId, workflow_id: this.fixture.scope.workflowId, pins_match: true, negative_cleanup: this.negativeCleanup }])
    }
    if (q.startsWith('select id,run_id,workflow_node_id,agent_id,attempt,record from harness_executions')) {
      expect(values).toEqual([this.execution.id, this.execution.runId])
      return rows([{ id: this.execution.id, run_id: this.execution.runId, workflow_node_id: this.execution.workflowNodeId,
        agent_id: this.execution.agentId, attempt: this.execution.attempt, record: this.execution }])
    }
    if (q.startsWith('select j.id,j.execution_id,j.state,j.record')) {
      return rows(this.reviewerRows)
    }
    if (q.startsWith('select i.id,i.execution_id,i.status,i.record')) {
      return rows(this.interactions.filter(({ value }) => value.id > String(values[2])).map(({ value, retired }) => ({
        id: value.id, execution_id: value.executionId, status: value.status, record: value, retired,
      })))
    }
    if (q.startsWith('select state,approval_native_ack_id from interaction_graph_resumes')) return rows(this.resume ? [this.resume] : [])
    if (q.startsWith('select effect_digest from run_graph_effects')) return rows(this.resumeDigest ? [{ effect_digest: this.resumeDigest }] : [])
    if (q.startsWith('select ( exists(select 1 from worker_credential_bindings')) {
      return rows([{ outstanding: this.resourcesOutstanding }])
    }
    if (q.startsWith('select reference,workflow_finalized_at')) return rows(this.hasSession ? [{ reference: this.session, finalized: this.finalized }] : [])
    if (q.startsWith('select c.record#>>')) return rows([{ harness: 'codex', agent_id: this.execution.agentId,
      workspace_id: this.fixture.scope.workspaceId, pinned: this.configurationPinned }])
    if (q.startsWith('select c.generation::text,c.execution_identity')) {
      if (!this.hasClosure) return rows([])
      this.closureReads++
      return rows([{ generation: this.replaceGenerationOnSecondRead && this.closureReads > 1 ? '18' : this.generation,
        execution_identity: this.closureIdentity ?? this.identity(this.execution), expected_reference: this.session,
        closed_reference: this.session, closed: this.closed, prior_unclosed: this.priorUnclosed,
        record: this.execution, reference: this.session }])
    }
    if (q.startsWith('select state,approval_native_ack_id,approval_native_ack_record,approval_native_ack_source')) {
      expect(values).toEqual([this.interactions[0]!.value.id])
      // A structurally valid ACK descriptor is still only a claim. Its named
      // ORIGINAL proof is deliberately absent below, so the production reader
      // must reject it for missing authority, not stop at a Zod parsing error.
      const interaction = this.interactions[0]!.value
      const nativeSource = { sourceKind: 'native_event', sourceId: 'missing-original-proof', sourceRevision: '1' }
      const digest = `sha256:${'a'.repeat(64)}`
      const descriptor = { scope: this.fixture.scope, interaction,
        requester: repeatExecutionIdentity(this.execution), occurrence: this.fixture.ref.occurrence,
        inputDigest: digest, acknowledgementId: this.resume?.approval_native_ack_id,
        originalProofId: nativeSource.sourceId, originalProofDigest: digest,
        nativeSource, nativeSourceDigest: digest,
        publication: { evidence: { sourceKind: 'native_event', sourceId: interaction.id,
          sourceRevision: String(interaction.revision) }, sourceDigest: digest, semanticDigest: digest } }
      return rows(this.resume ? [{ ...this.resume, approval_native_ack_record: descriptor,
        approval_native_ack_source: nativeSource }] : [])
    }
    if (q.startsWith('select record,source_digest from workflow_native_proofs')) {
      expect(values).toEqual(['missing-original-proof', this.execution.runId, this.execution.id])
      return rows([]) // No coordinator capture exists; never manufacture one.
    }
    if (this.entryFixture && this.entryReservation) {
      const f = this.entryFixture, reservation = this.entryReservation
      if (q.startsWith('select r.id,r.workspace_id,r.workflow_id,r.workflow_version_id,r.execution_state,')) {
        expect(values).toEqual([f.run.id]); return rows([currentUnitRunRow(f)])
      }
      if (q.startsWith('with pinned_version')) {
        expect(values).toEqual([f.version.id, f.run.workspaceId, f.run.workflowId,
          Object.values(f.run.agentConfigurationVersionIds)])
        return rows([{ versions: [currentUnitVersionRow(f)], configurations: currentUnitConfigurationRows(f) }])
      }
      if (q.startsWith('with pinned_head')) {
        expect(values).toEqual([this.execution.id, f.run.id])
        return rows([{ heads: [{ protocol_version: 1 }], effects: [{ payload_digest: this.bindingDigest }],
          executions: [{ record: this.execution, accepted: false, identity: repeatExecutionIdentity(this.execution),
            slot_id: repeatSlotId(f.run.id, reservation.ref), occurrence_id: null,
            execution_occurrence_id: null, identity_occurrence_id: null, technical_attempt: this.execution.attempt,
            execution_run_id: this.execution.runId, execution_node_id: this.execution.workflowNodeId,
            execution_agent_id: this.execution.agentId, execution_attempt: this.execution.attempt,
            workflow_node_id: this.execution.workflowNodeId, input_json: JSON.stringify(this.execution.input),
            input_digest: reservation.inputDigest }] }])
      }
      if (q.startsWith('select id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record')) {
        expect(values).toEqual([f.version.id, f.run.workspaceId, f.run.workflowId])
        return rows([currentUnitVersionRow(f)])
      }
      if (q.startsWith('select id,workspace_id,agent_id,version,record from agent_configuration_versions')) {
        expect(values).toEqual([f.run.workspaceId, Object.values(f.run.agentConfigurationVersionIds)])
        return rows(currentUnitConfigurationRows(f))
      }
      if (q === 'select protocol_version from run_graph_heads where run_id=$1 for share') {
        expect(values).toEqual([f.run.id]); return rows([{ protocol_version: 1 }])
      }
      if (q.startsWith('select e.record,e.accepted,x.identity,s.slot_id,')) {
        expect(values).toEqual([this.execution.id, f.run.id])
        return rows([{ record: this.execution, accepted: false, identity: repeatExecutionIdentity(this.execution),
          slot_id: repeatSlotId(f.run.id, reservation.ref), occurrence_id: null,
          execution_occurrence_id: null, identity_occurrence_id: null, technical_attempt: this.execution.attempt,
          execution_run_id: this.execution.runId, execution_node_id: this.execution.workflowNodeId,
          execution_agent_id: this.execution.agentId, execution_attempt: this.execution.attempt,
          workflow_node_id: this.execution.workflowNodeId, input_json: JSON.stringify(this.execution.input),
          input_digest: reservation.inputDigest }])
      }
      if (q.startsWith('select payload_digest from run_repeat_effects')) {
        expect(values).toEqual([f.run.id, 'input.bind', this.execution.id])
        return rows([{ payload_digest: this.bindingDigest }])
      }
      if (q.includes('join run_graph_sources s')) {
        const receipt = canonicalRepeatEffectReceipt(f.scope, { kind: 'input.bind', entityId: this.execution.id, digest: this.bindingDigest })
        expect(values).toEqual([f.run.id, receipt.evidence.sourceKind, receipt.evidence.sourceId,
          receipt.evidence.sourceRevision, receipt.effect!.kind, receipt.effect!.entityId])
        return rows([{ workspace_id: f.scope.workspaceId, workflow_id: f.scope.workflowId,
          workflow_version_id: f.scope.workflowVersionId, execution_semantics_version: 3, protocol_version: 1,
          head_sequence: '1', source_digest: this.bindingDigest, source_semantic_digest: repeatDigest(reservation), source_sequence: '1',
          effect_digest: this.bindingDigest, effect_semantic_digest: repeatDigest(reservation), effect_sequence: '1' }])
      }
      if (q.startsWith('select phase,reservation,reservation_digest,transition,source_id,source_digest from workflow_native_entries')) {
        expect(values).toEqual([this.execution.id, f.run.id])
        return rows(this.entryPhase === null ? [] : [{ phase: this.entryPhase, reservation,
          reservation_digest: repeatDigest(reservation), transition: this.entryPhase === 'reserved' ? null : {
            reservation, phase: this.entryPhase, ownerId: 'unit-owner', ownerFence: '1', launchDigest: this.bindingDigest,
          }, source_id: null, source_digest: null }])
      }
      if (q.startsWith('select generation::text,execution_identity,')) {
        expect(values).toEqual([this.execution.id])
        return rows([]) // Entered is possible submission, not a positive dispose receipt.
      }
    }
    if (q.startsWith('select p.generation::text,p.execution_identity,p.reference')) {
      expect(values).toEqual([this.execution.id])
      // This model seeds no kernel-backed recovery receipt. An absent original
      // close must reach the real pending gate, not become an unscripted query.
      return rows([])
    }
    if (q.startsWith('update execution_native_sessions')) {
      if (!this.casMatches) return rows([])
      this.finalized = true
      this.updateCount++
      return rows([{ execution_id: this.execution.id }])
    }
    throw new Error(`Unhandled SQL shape: ${q}`)
  }
  async settle(): Promise<void> {
    const original = this.finalized
    const connection = new ExclusiveGraphConnection(this as unknown as pg.ClientBase, () => undefined)
    try { await connection.transaction((sql) => settleRepeatNativeExecutionLocked(sql, this.execution.runId, this.execution)) }
    catch (error) { this.finalized = original; throw error }
    finally { await connection.close() }
  }
  unboundExecution() {
    const f = currentUnitSnapshot('eng04-native-unbound')
    f.run = { ...f.run, executionState: 'running', startedAt: f.createdAt }
    this.fixture.scope = f.scope
    const identity = f.identities[0]!, ref = { nodeId: identity.workflowNodeId, occurrence: null }
    const candidate = HarnessExecutionSchema.parse({ id: identity.executionId, runId: f.run.id,
      workflowNodeId: identity.workflowNodeId, agentId: identity.agentId,
      agentConfigurationVersionId: identity.agentConfigurationVersionId, attempt: 1,
      input: {}, createdAt: f.createdAt, state: 'queued' })
    const binding = bindRepeatNodeInput({ version: f.version, runInput: f.run.input, recipient: candidate,
      ref, occurrence: null, entry: null, predecessors: [] })
    this.execution = HarnessExecutionSchema.parse({ ...candidate, input: binding.input, state: 'completed',
      finishedAt: f.createdAt, result: { outcome: 'failed', error: {
        code: 'ADMISSION_FAILED', message: 'not launched', retryable: false,
      } } })
    this.entryFixture = f
    this.entryReservation = workflowNativeReservation(f.scope, ref, this.execution, repeatDigest(binding.input, 4 * 1024 * 1024))
    // This is preexisting input admission in the SQL model, not native entry.
    this.bindingDigest = repeatDigest({ execution: repeatExecutionIdentity(candidate), input: binding.input, bindings: binding.bindings })
    this.hasSession = false
  }
  delivered() {
    const value = DurableInteractionSchema.parse({ ...NATIVE_INTERACTION_FIXTURES.codex,
      id: 'native-interaction-one', executionId: this.execution.id, runId: this.execution.runId,
      workspaceId: this.fixture.scope.workspaceId, workflowId: this.fixture.scope.workflowId,
      graphThreadId: this.execution.runId, requestingAgentId: this.execution.agentId, nativeSessionId: this.execution.nativeSessionId,
      graphInterruptId: 'exact-interrupt-one', status: 'delivered', deliveryState: 'delivered', deliveredAt: nativeAt,
      selectedOptionId: 'codex-approve-once', selectedSemantic: 'approve_once', nativeResponse: { decision: 'accept' }, decidedAt: nativeAt,
    })
    this.interactions = [{ value, retired: false }]
    this.resumeDigest = graphSourceDigest({ interactionId: value.id, runId: value.runId, executionId: value.executionId,
      graphThreadId: value.graphThreadId, graphInterruptId: value.graphInterruptId, decision: decisionDigest(value) })
    return value
  }
}

describe('ENG04 native SQL-shaped exact per-execution settlement', () => {
  it('finalizes a closed execution while its Run is still running, and replays without a second write', async () => {
    const sql = new NativePgShape(), before = structuredClone(sql.execution)
    await sql.settle()
    await sql.settle()
    expect(sql.finalized).toBe(true)
    expect(sql.updateCount).toBe(1)
    expect(sql.execution).toEqual(before)
    expect(sql.calls.some((q) => /update harness_executions|update runs|approval_native_ack_id\s*=|insert/.test(q))).toBe(false)
  })
  it('recovers after a process restart using durable close, without an in-memory manager', async () => {
    const sql = new NativePgShape()
    // This fixture has no manager, fake native acknowledgment or native callback.
    await sql.settle()
    expect(sql.closureReads).toBe(4) // Entry and before-COMMIT both recheck current and final close generations.
    expect(sql.finalized).toBe(true)
  })
  it.each(['hasClosure', 'closed'] as const)('keeps %s uncertainty open even when workflow finalization was previously set', async (key) => {
    const sql = new NativePgShape()
    sql.finalized = true
    sql[key] = false
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(sql.updateCount).toBe(0)
  })
  it('rejects an older unclosed generation and a changed current generation', async () => {
    const sql = new NativePgShape()
    sql.priorUnclosed = true
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    sql.priorUnclosed = false
    sql.closureReads = 0
    sql.replaceGenerationOnSecondRead = true
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.finalized).toBe(false)
  })
  it('rejects a closure belonging to a different execution identity', async () => {
    const sql = new NativePgShape()
    sql.closureIdentity = { ...sql.identity(sql.execution), attempt: 2 }
    await expect(sql.settle()).rejects.toMatchObject({ code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' })
    expect(sql.finalized).toBe(false)
  })
  it('requires actual credential, budget and reviewer settlement', async () => {
    const sql = new NativePgShape()
    sql.resourcesOutstanding = true
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(sql.updateCount).toBe(0)
  })
  it.each(['uncertain', 'submitted', 'blocked_busy'])('blocks an exact reviewer job still %s', async (state) => {
    const sql = new NativePgShape()
    const job = { id: 'job-one', interactionId: 'native-interaction-one', reviewerAgentId: 'agent-review', attempt: 1,
      state, provider: 'codex', nativeSessionId: sql.session.nativeSessionId,
      correlationId: 'review:job-one', createdAt: nativeAt, updatedAt: nativeAt }
    sql.reviewerRows.push({ id: job.id, execution_id: sql.execution.id, state, record: job, run_id: sql.execution.runId, same_run: true })
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(sql.updateCount).toBe(0)
  })
  it('does not silently drop a reviewer binding crossed to another Run', async () => {
    const sql = new NativePgShape()
    const job = { id: 'job-one', interactionId: 'native-interaction-one', reviewerAgentId: 'agent-review', attempt: 1,
      state: 'completed', provider: 'codex', nativeSessionId: sql.session.nativeSessionId,
      correlationId: 'review:job-one', createdAt: nativeAt, updatedAt: nativeAt }
    sql.reviewerRows.push({ id: job.id, execution_id: sql.execution.id, state: job.state, record: job, run_id: 'other-run', same_run: false })
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.updateCount).toBe(0)
  })
  it('rejects a changed accepted configuration or finalization compare-and-swap', async () => {
    const sql = new NativePgShape()
    sql.configurationPinned = false
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    sql.configurationPinned = true
    sql.casMatches = false
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.finalized).toBe(false)
  })
  it.each(['1', '2', '4'])('does not claim semantics %s through the repeat-only gate', async (semantics) => {
    const sql = new NativePgShape()
    sql.semantics = semantics
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.updateCount).toBe(0)
  })
  it('does not infer native success from an absent session row', async () => {
    const sql = new NativePgShape()
    sql.hasSession = false
    // A recorded native identity/success contradicts a missing binding; this is
    // an identity conflict, not permission to use the unbound-entry path.
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.updateCount).toBe(0)
    expect(sql.finalized).toBe(false)
  })
  it('keeps a negative execution without a native row pending until original no-dispatch proof exists', async () => {
    const sql = new NativePgShape()
    sql.unboundExecution()
    const original = structuredClone(sql.execution)
    for (const phase of ['reserved', 'prepared'] as const) {
      sql.entryPhase = phase
      await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_BOUNDARY_PENDING' })
    }
    sql.entryPhase = 'entered'
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    sql.entryPhase = null
    await expect(sql.settle()).rejects.toMatchObject({ code: 'NATIVE_ENTRY_CONFLICT' })
    expect(sql.calls.some((q) => q.includes('from workflow_native_entries'))).toBe(true)
    expect(sql.calls.some((q) => q.includes('from execution_native_closures'))).toBe(true)
    expect(sql.updateCount).toBe(0)
    expect(sql.finalized).toBe(false)
    expect(sql.execution).toEqual(original)
    expect(sql.calls.some((q) => /^(insert|update|delete) /.test(q))).toBe(false)
  })
  it('requires delivery, checkpoint consumption and real native acknowledgment separately', async () => {
    const sql = new NativePgShape()
    sql.delivered()
    sql.resume = { state: 'resumed', approval_native_ack_id: null }
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    sql.resume = { state: 'resuming', approval_native_ack_id: 'real-history-ack' }
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    sql.resume = { state: 'resumed', approval_native_ack_id: 'real-history-ack' }
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(sql.calls.some((q) => q.startsWith('select state,approval_native_ack_id,approval_native_ack_record'))).toBe(true)
    expect(sql.calls.some((q) => q.startsWith('select record,source_digest from workflow_native_proofs'))).toBe(true)
    expect(sql.updateCount).toBe(0)
    expect(sql.finalized).toBe(false)
  })
  it.each(['workspaceId', 'workflowId', 'providerVersion'] as const)('rejects an approval from another %s', async (key) => {
    const sql = new NativePgShape(), delivered = sql.delivered()
    sql.interactions = [{ value: DurableInteractionSchema.parse({ ...delivered, [key]: 'other' }), retired: false }]
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.updateCount).toBe(0)
  })
  it('requires the exact same-command checkpoint digest, not just an existing effect row', async () => {
    const sql = new NativePgShape()
    sql.delivered()
    sql.resumeDigest = `sha256:${'f'.repeat(64)}`
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_APPROVAL_RECEIPT_CONFLICT' })
    sql.resumeDigest = null
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(sql.finalized).toBe(false)
  })
  it('allows negative Stop retirement without inventing a positive acknowledgment', async () => {
    const sql = new NativePgShape(), delivered = sql.delivered()
    sql.interactions = [{ value: DurableInteractionSchema.parse({ ...delivered, status: 'canceled' }), retired: true }]
    sql.resume = null
    sql.resumeDigest = null
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    sql.negativeCleanup = true
    await sql.settle()
    expect(sql.finalized).toBe(true)
    expect(sql.resume).toBeNull()
    expect(sql.execution.result?.outcome).toBe('succeeded') // Preserved pre-Stop business evidence.
  })
  it('refuses canceled interaction cleanup without its canonical retirement receipt', async () => {
    const sql = new NativePgShape(), delivered = sql.delivered()
    sql.negativeCleanup = true
    sql.interactions = [{ value: DurableInteractionSchema.parse({ ...delivered, status: 'canceled' }), retired: false }]
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(sql.updateCount).toBe(0)
  })
})
