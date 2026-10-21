import { EventEmitter } from 'node:events'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { AcceptedRepeatStartV1Schema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { RunBoardSnapshotSchema } from '@foreman-code/contracts/run-snapshots'
import { publicRunActivity, type ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { projectRunBoardSnapshot } from '../src/modules/runs/boardSnapshotProjection.js'
import { inspectionExecutionRowSummary, RunInspectionService } from '../src/modules/runs/inspection.js'
import { projectRunLiveActivity } from '../src/modules/runs/liveActivity.js'
import { admitWorkHandoffLocked, readWorkActivationInputLocked, returnWorkHandoffLocked } from '../src/modules/runs/workHandoffAdmission.js'
import { availableWorkAlternativesLocked, persistWorkLimitNoticeLocked } from '../src/modules/runs/workHandoffNotice.js'
import { repeatDigest, repeatSlotId } from '../src/modules/runs/repeatResolution.js'
import { validateReviewerBootstrap } from '../src/modules/workflows/reviewerBootstrap.js'
import { currentUnitSnapshot, currentUnitRunRow, currentUnitVersionRow, currentUnitConfigurationRows } from './helpers/currentUnitSnapshot.js'
import { jobExecution } from './helpers/jobFixture.js'
import { canonicalRepeatEffectReceipt } from '../src/modules/run-graph/repeatPublication.js'

const job = { kind: 'job' as const, id: 'build-node', name: 'Accepted build', jobDefinitionId: 'build-definition',
  jobDefinitionRevision: 7, jobDefinitionVersionId: 'build-version-7' }
function mixed() {
  const f = currentUnitSnapshot('mixed-history')
  f.version.definition.nodes.push({ ...job, position: { x: -12, y: 91 }, width: 244, height: 132 })
  f.version.definition.edges.push({ id: 'build-edge', kind: 'execution', source: f.version.entryNodeId, target: job.id })
  f.version.definition.executionPolicy!.maxNodeExecutions = 2
  f.version.contentHash = repeatDigest({ definition: f.version.definition,
    configurations: f.version.agentConfigurationVersionIds, entryNodeId: f.version.entryNodeId })
  WorkflowVersionV3Schema.parse(f.version)
  const snapshot = { run: f.run, version: f.version, configurations: f.configurations, stopRequested: false, cleanupPending: false }
  return { f, snapshot }
}
function accepted() {
  const { f } = mixed()
  return AcceptedRepeatStartV1Schema.parse({ run: f.run, snapshot: {
    request: { workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, workflowVersionId: f.version.id,
      executionSemanticsVersion: 3, commandId: 'mixed-admission', expectedWorkflowRevision: 1,
      expectedAgentConfigurationVersionIds: f.run.agentConfigurationVersionIds, expectedLocationRevision: 1, input: {} },
    authorizationPrincipalId: f.run.authorizationPrincipalId,
    executable: { version: f.version, configurations: f.configurations },
    workflow: { id: f.run.workflowId, workspaceId: f.run.workspaceId, revision: 1, currentVersionId: f.version.id,
      archived: false, definition: f.version.definition },
    workspace: { id: f.run.workspaceId, archived: false, location: f.run.executionLocation }, draft: null,
  } })
}
function jobRow() {
  const { f, snapshot } = mixed()
  const identity = { kind: 'job' as const, executionId: 'actual-job-execution', workflowNodeId: job.id,
    jobDefinitionId: job.jobDefinitionId, jobDefinitionVersionId: job.jobDefinitionVersionId, attempt: 1 }
  const row = { id: identity.executionId, run_id: f.run.id, workflow_node_id: job.id, agent_id: '', attempt: 1,
    job_pinned: true, job_definition_revision: job.jobDefinitionRevision,
    repeat_occurrence_id: null, accepted: false, summary: { ...identity, state: 'queued', createdAt: f.createdAt,
      acceptedResultAvailable: false }, reported_outcome: null, page_created_at: f.createdAt, identity,
    identity_run_id: f.run.id, identity_occurrence_id: null, technical_attempt: 1,
    slot_id: repeatSlotId(f.run.id, { nodeId: job.id, occurrence: null }), slot_run_id: f.run.id,
    slot_node_id: job.id, slot_occurrence_id: null, occurrence_id: null, occurrence_run_id: null,
    occurrence_workspace_id: null, occurrence_workflow_id: null, occurrence_version_id: null,
    occurrence_block_id: null, occurrence_index: null, occurrence_identity: null }
  return { snapshot, row }
}

describe('mixed-node admission and immutable history projections', () => {
  it('captures exact Job pins and saved geometry without Agent fields or mutable aliases', () => {
    const input = accepted(), capture = RunBoardSnapshotSchema.parse(projectRunBoardSnapshot(input))
    expect(capture.kind).toBe('available')
    if (capture.kind !== 'available') throw new Error('Expected accepted capture')
    expect(capture.nodes[1]).toEqual({ kind: 'job', id: job.id, name: job.name,
      jobDefinitionId: job.jobDefinitionId, jobDefinitionRevision: 7, jobDefinitionVersionId: job.jobDefinitionVersionId,
      position: { x: -12, y: 91 }, size: { width: 244, height: 132 } })
    const saved = input.snapshot.workflow.definition.nodes[1]!
    saved.name = 'New display name'; saved.position!.x = 999
    expect(capture.nodes[1]!.name).toBe(job.name)
    expect(capture.nodes[1]!.position.x).toBe(-12)
    expect(capture.nodes[1]).not.toHaveProperty('agentId')
  })
  it.each(['jobDefinitionId', 'jobDefinitionRevision', 'jobDefinitionVersionId'] as const)('refuses changed saved Job %s', (field) => {
    const input = accepted(), node = input.snapshot.workflow.definition.nodes[1]!
    if (node.kind !== 'job') throw new Error('Expected Job')
    if (field === 'jobDefinitionRevision') node[field]++
    else node[field] = 'different-definition-pin'
    expect(() => projectRunBoardSnapshot(input)).toThrow(expect.objectContaining({ code: 'RUN_SNAPSHOT_PIN_CONFLICT' }))
  })
  it('retains exact Job inspection identity and refuses another version, attempt or Run', () => {
    const { snapshot, row } = jobRow()
    expect(inspectionExecutionRowSummary(row, snapshot)).toEqual(row.summary)
    expect(inspectionExecutionRowSummary(row, snapshot)).not.toHaveProperty('agentId')
    for (const changed of [{ ...row, technical_attempt: 2 }, { ...row, run_id: 'another-run' },
      { ...row, summary: { ...row.summary, jobDefinitionVersionId: 'new-version' } },
      { ...row, identity: { ...row.identity, kind: 'agent', agentId: 'fake-agent' } }]) {
      expect(() => inspectionExecutionRowSummary(changed, snapshot)).toThrow(expect.objectContaining({ code: 'RUN_INSPECTION_EVIDENCE_CONFLICT' }))
    }
  })
  it('keeps the native-action projection Agent-only in a mixed graph', () => {
    const { f } = mixed()
    const value = projectRunLiveActivity({ run: f.run, definition: f.version.definition, executions: [], events: [], reviews: [] })
    expect(value.nodes.map((node) => node.workflowNodeId)).toEqual([f.version.entryNodeId])
    expect(f.version.definition.nodes[1]).toMatchObject(job)
  })
  it('rejects Job requester/target handoff operations before any native admission or SQL writes', async () => {
    const { f } = mixed(), query = vi.fn(), authority = vi.fn()
    f.version.definition.handoffs = { contractVersion: 1 }
    const context = { sql: { query } as never, scope: f.scope, version: f.version, now: f.createdAt,
      hooks: { assertAuthorityLocked: authority } as never, assertActive: vi.fn() }
    await expect(admitWorkHandoffLocked(context, 'original-request')).rejects.toMatchObject({ code: 'WORK_POLICY_PIN_CONFLICT' })
    await expect(readWorkActivationInputLocked(context, 'original-activation')).rejects.toMatchObject({ code: 'WORK_POLICY_PIN_CONFLICT' })
    await expect(returnWorkHandoffLocked(context, 'original-return')).rejects.toMatchObject({ code: 'WORK_POLICY_PIN_CONFLICT' })
    await expect(availableWorkAlternativesLocked(context, job.id, 'original-edge')).rejects.toMatchObject({ code: 'WORK_POLICY_PIN_CONFLICT' })
    await expect(persistWorkLimitNoticeLocked(context, { cause: { kind: 'limit_denial', denialId: 'original-denial' },
      requesterActivationId: 'original-requester', requesterNodeId: f.version.entryNodeId, continuationActivationId: 'original-continuation',
      relationshipId: 'build-edge', destinationNodeId: job.id, used: 1, maximum: 1, latestDeliverable: {}, remainingFindings: [] }))
      .rejects.toMatchObject({ code: 'WORK_POLICY_PIN_CONFLICT' })
    expect(query).not.toHaveBeenCalled(); expect(authority).not.toHaveBeenCalled()
  })
  it('uses the real Agent reviewer alongside Jobs and refuses Job entry bootstrap', () => {
    const f = makeCurrentWorkflowFixture('mixed-review-bootstrap', 'approval')
    const version: WorkflowVersionV3 = f.version
    version.definition.nodes.push(job)
    expect(() => validateReviewerBootstrap(version.definition, version.approval, f.configurations[0]!.harness)).not.toThrow()
    version.definition.entryNodeId = job.id
    expect(() => validateReviewerBootstrap(version.definition, version.approval, f.configurations[0]!.harness))
      .toThrow(expect.objectContaining({ code: 'APPROVAL_REVIEWER_BOOTSTRAP_ORDER' }))
  })
  it('retains Run activity rows without inventing a Job Agent actor', () => {
    const { f } = mixed()
    const row: ActivityReadRow = { sequence: '9', source: 'backend', kind: 'node_state_changed', occurred_at: new Date(f.createdAt),
      harness_execution_id: 'actual-job-execution', execution_node_id: job.id, execution_agent_id: null,
      execution_attempt: 1, work_activation_id: null, result_outcome: 'failed', safe_payload: { state: 'completed' }, native: null }
    const value = publicRunActivity(row, f.version, f.run.id, f.run.outcome)
    expect(value.status).toBe('failed'); expect(value.refs.executionId).toBe('actual-job-execution')
    expect(value.actor).toBeUndefined(); expect(value.refs.technicalAttempt).toBe(1)
    const pinned = { ...row, harness_execution_id: null, job_execution_id: 'actual-job-execution',
      node_execution_id: 'actual-job-execution', job_attempt_id: 'job-attempt', job_operation_id: 'job-operation',
      job_definition_id: job.jobDefinitionId, job_definition_revision: job.jobDefinitionRevision,
      job_definition_version_id: job.jobDefinitionVersionId }
    f.version.definition.nodes[1]!.name = 'Accepted Job name '.repeat(8)
    const captured = { ...pinned, safe_payload: { ...pinned.safe_payload, actorName: f.version.definition.nodes[1]!.name } }
    const projected = publicRunActivity(captured, f.version, f.run.id, f.run.outcome)
    expect(projected.kind).toBe('job_work'); expect(projected.summary).toBe('Job work completed')
    expect(projected.actor).toMatchObject({ kind: 'job', nodeName: f.version.definition.nodes[1]!.name,
      jobDefinitionId: job.jobDefinitionId, jobDefinitionRevision: 7, jobDefinitionVersionId: job.jobDefinitionVersionId })
    expect(projected.actor).not.toHaveProperty('agentId')
    expect(projected.refs).toMatchObject({ jobExecutionId: 'actual-job-execution', jobAttemptId: 'job-attempt', jobOperationId: 'job-operation' })
    expect(publicRunActivity({ ...pinned, job_definition_version_id: 'different' }, f.version, f.run.id, f.run.outcome).actor).toBeUndefined()
  })
})

describe('mixed immutable version history uses current Run/workflow grants', () => {
  it('revalidates persisted grants and never reads Job history through a stale transport grant', async () => {
    const { f } = mixed()
    const principal: ManagementPrincipal = { id: 'history-reader', name: 'Reader', audience: 'operator', revokedAt: null,
      expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions: ['runs:read', 'workflows:read'],
        scope: { workspaceIds: [f.run.workspaceId], workflowIds: [f.run.workflowId] } }] }
    let grants = principal.grants
    const execution = jobExecution()
    execution.id = '11111111-1111-4111-8111-111111111111'
    execution.attemptId = '22222222-2222-4222-8222-222222222222'
    execution.operationId = '33333333-3333-4333-8333-333333333333'
    execution.workspaceId = f.run.workspaceId
    execution.workflow = { runId: f.run.id, workflowId: f.run.workflowId, nodeId: job.id, nodeExecutionId: execution.id }
    const inputValue = { executionSemanticsVersion: 3, runInput: f.run.input, occurrence: null, entry: null, predecessors: [] }
    execution.acceptedSpec = { ...execution.acceptedSpec, definitionId: job.jobDefinitionId, definitionRevision: 7,
      definitionVersionId: job.jobDefinitionVersionId, workflowInput: inputValue }
    const identity = { kind: 'job', workflowNodeId: job.id, executionId: execution.id,
      jobDefinitionId: job.jobDefinitionId, jobDefinitionVersionId: job.jobDefinitionVersionId, attempt: 1 }
    const jobScope = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, runId: f.scope.runId,
      workflowVersionId: f.scope.workflowVersionId }
    const preparation = { executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId,
      ...jobScope, nodeId: job.id, input: inputValue, inputDigest: repeatDigest(inputValue) }
    const metadata = { ...jobRow().row, reference: { kind: 'job', ...jobScope, nodeId: job.id, nodeExecutionId: execution.id,
      jobExecutionId: execution.id, occurrenceId: null, occurrenceIndex: 0 }, input_json: JSON.stringify(inputValue),
      terminal_processed: false, identity, slot_input: JSON.stringify(inputValue), input_digest: repeatDigest(inputValue),
      preparation, occurrence_key: null }
    let receiptAvailable = true
    const effectDigest = repeatDigest({ actual: 'test input effect' }), semantic = repeatDigest({ actual: 'test graph metadata' })
    const receipt = canonicalRepeatEffectReceipt(f.scope, { kind: 'input.bind', entityId: execution.id, digest: effectDigest }, semantic)
    const terminalReceipt = canonicalRepeatEffectReceipt(f.scope, { kind: 'terminal.accept', entityId: execution.id, digest: effectDigest }, semantic)
    const acceptedValue = { outcome: 'succeeded', output: { latestDeliverable: { jobExecutionId: execution.id,
      process: { outcome: 'succeeded', exitCode: 0, signal: null }, publication: 'complete', artifacts: [] }, remainingFindings: [] } }
    const acceptedDigest = repeatDigest(acceptedValue)
    const queries: string[] = []
    const client = Object.assign(new EventEmitter(), { release: vi.fn(), query: async (text: string, values: unknown[] = []) => {
      const q = text.replace(/\s+/g, ' ').trim(); queries.push(q)
      let rows: unknown[]
      if (q.startsWith('begin ') || q === 'commit' || q === 'rollback') rows = []
      else if (q.startsWith('select workspace_id,workflow_id from runs')) rows = [{ workspace_id: f.run.workspaceId, workflow_id: f.run.workflowId }]
      else if (q.includes('from management_principals')) rows = [{ ...principal, grants, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }]
      else if (q.startsWith('select r.id,r.workspace_id')) rows = [currentUnitRunRow(f)]
      else if (q.startsWith('with pinned_version as materialized')) rows = [{ versions: [currentUnitVersionRow(f)],
        configurations: currentUnitConfigurationRows(f) }]
      else if (q.includes('from workflow_versions')) rows = [currentUnitVersionRow(f)]
      else if (q.includes('from agent_configuration_versions')) rows = currentUnitConfigurationRows(f)
      else if (q.startsWith('select id from harness_executions')) rows = []
      else if (q.startsWith('select w.reference')) rows = [metadata]
      else if (q.startsWith('select record,accepted_spec from job_executions')) rows = [{ record: execution, accepted_spec: execution.acceptedSpec }]
      else if (q.startsWith('select payload_digest from run_repeat_effects')) rows = [{ payload_digest: effectDigest }]
      else if (q.startsWith('select binding_id,run_id,recipient_execution_id')) rows = []
      else if (q.startsWith('select result_json,result_digest,occurrence_id')) rows = [{ result_json: JSON.stringify(acceptedValue), result_digest: acceptedDigest, occurrence_id: null }]
      else if (q.startsWith('select record from run_repeat_resolutions')) rows = [{ record: { value: { workflowNodeId: job.id,
        execution: identity, resolution: 'succeeded', acceptedResultDigest: acceptedDigest, branchEnded: false,
        selectedRelationshipIds: [], unselectedRelationshipIds: [], resolvedAt: f.createdAt } } }]
      else if (q.includes('join run_graph_sources s')) rows = receiptAvailable ? [{ workspace_id: f.scope.workspaceId,
        workflow_id: f.scope.workflowId, workflow_version_id: f.scope.workflowVersionId, execution_semantics_version: 3,
        protocol_version: 1, head_sequence: '4', source_digest: values[1] === 'node_resolution' ? terminalReceipt.sourceDigest : receipt.sourceDigest,
        source_semantic_digest: semantic, source_sequence: '1', effect_digest: values[1] === 'node_resolution' ? terminalReceipt.effect!.digest : receipt.effect!.digest,
        effect_semantic_digest: semantic, effect_sequence: '1' }] : []
      else throw new Error(`Unexpected history query: ${q}`)
      return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
    } })
    const service = new RunInspectionService({ connect: async () => client } as unknown as pg.Pool)
    const input = { workspaceId: f.run.workspaceId, runId: f.run.id }
    const value = await service.version(principal, input)
    expect(value.version).toEqual(f.version); expect(value.version.definition.nodes[1]).toMatchObject(job)
    const detailInput = { ...input, executionId: execution.id }
    const detail = await service.executionDetail(principal, detailInput)
    expect(detail.execution).toMatchObject(identity)
    expect(detail.acceptedInput).toEqual({ digest: repeatDigest(inputValue), value: inputValue })
    expect(detail.acceptedResult).toEqual({ status: 'not_accepted' })
    expect(detail.execution).not.toHaveProperty('agentId')
    expect((await service.bindings(principal, detailInput)).items).toEqual([])
    execution.process = { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true }
    execution.startedAt = f.createdAt; execution.finishedAt = f.createdAt
    execution.publication = 'expired'; metadata.accepted = true; metadata.terminal_processed = true
    const finished = await service.executionDetail(principal, detailInput)
    expect(finished.acceptedResult).toEqual({ status: 'accepted', digest: acceptedDigest, value: acceptedValue })
    expect(finished.execution).toMatchObject({ kind: 'job', state: 'completed', finishedAt: f.createdAt })
    acceptedValue.output.latestDeliverable.jobExecutionId = 'different-job'
    await expect(service.executionDetail(principal, detailInput)).rejects.toMatchObject({ code: 'RUN_INSPECTION_EVIDENCE_CONFLICT' })
    acceptedValue.output.latestDeliverable.jobExecutionId = execution.id
    preparation.attemptId = '44444444-4444-4444-8444-444444444444'
    await expect(service.executionDetail(principal, detailInput)).rejects.toMatchObject({ code: 'RUN_INSPECTION_EVIDENCE_CONFLICT' })
    preparation.attemptId = execution.attemptId; receiptAvailable = false
    await expect(service.executionDetail(principal, detailInput)).rejects.toMatchObject({ code: 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
    grants = []; queries.length = 0
    await expect(service.version(principal, input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(service.executionDetail(principal, detailInput)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(queries.some((q) => q.includes('from workflow_versions'))).toBe(false)
    expect(f.version.definition).not.toHaveProperty('repeat')
  })
})
