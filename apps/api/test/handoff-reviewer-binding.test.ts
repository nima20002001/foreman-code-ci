import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema, type ExecutionResult, type HarnessExecution } from '@foreman-code/contracts'
import { WorkActivationInputSchema, WorkflowVersionV3Schema, workLimitNoticeText, type WorkActivationInput,
  type WorkRequest } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../src/modules/run-graph/connection.js'
import { PostgresRepeatReviewerBindings } from '../src/modules/interactions/repeatReviewer.js'
import { repeatDigest, repeatExecutionIdentity, workActivationSlotId } from '../src/modules/runs/repeatResolution.js'
import { approvalFixture } from './helpers/wave25ApprovalFixture.js'

function fixture() {
  const base = approvalFixture()
  const version = WorkflowVersionV3Schema.parse({ ...base.version, definition: {
    ...base.version.definition, handoffs: { contractVersion: 1 },
    executionPolicy: { maxParallelism: 2, maxNodeExecutions: 12 },
    edges: base.version.definition.edges.map((edge) => edge.kind === 'execution'
      ? { ...edge, workRequestDirection: 'both' } : edge),
  } })
  const scope = { runId: base.run.id, workspaceId: base.run.workspaceId, workflowId: base.run.workflowId,
    workflowVersionId: version.id, executionSemanticsVersion: 3 as const }
  const result: ExecutionResult = { outcome: 'succeeded', output: {
    routing: { kind: 'finish' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
  } }
  const executions = new Map<string, HarnessExecution>()
  const rows = new Map<string, ReturnType<typeof executionRow>>()
  const requests = new Map<string, WorkRequest>()
  const returns = new Map<string, unknown>()
  const denials = new Map<string, unknown>()
  const parentBindings = new Map<string, string>()
  const receipts = new Map<string, { result_json: string; result_digest: string }>()
  function executionRow(execution: HarnessExecution, accepted: boolean) {
    const work = WorkActivationInputSchema.parse(execution.input).work
    return { record: execution, identity: repeatExecutionIdentity(execution), accepted,
      execution_id: execution.id, run_id: scope.runId, workflow_node_id: execution.workflowNodeId,
      agent_id: execution.agentId, attempt: execution.attempt, technical_attempt: execution.attempt,
      slot_id: workActivationSlotId(scope.runId, work.activation.activationId), occurrence_id: null,
      execution_occurrence_id: null, identity_occurrence_id: null, occurrence_record: null,
      work_activation_id: work.activation.activationId, execution_activation_id: work.activation.activationId,
      identity_activation_id: work.activation.activationId, activation_record: work.activation,
      input_json: JSON.stringify(execution.input), input_digest: repeatDigest(execution.input, 4 * 1024 * 1024) }
  }
  function add(id: string, nodeId: string, work: WorkActivationInput['work'],
    options: { accepted?: boolean; result?: ExecutionResult } = {}) {
    const accepted = options.accepted !== false
    const terminal = options.result ?? result
    const input = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: base.run.input,
      occurrence: null, entry: null, predecessors: [], work })
    const original = base.executions.find((value) => value.workflowNodeId === nodeId)!
    const execution = HarnessExecutionSchema.parse({ ...original, id, input, nativeSessionId: `session-${id}`,
      state: accepted ? 'completed' : 'waiting', ...(accepted ? { result: terminal, finishedAt: base.createdAt } : {}) })
    executions.set(id, execution)
    rows.set(id, executionRow(execution, accepted))
    if (accepted) receipts.set(id, { result_json: JSON.stringify(terminal), result_digest: repeatDigest(terminal, 64 * 1024) })
    return execution
  }
  const activation = (id: string, nodeId: string, cause: WorkActivationInput['work']['activation']['cause']) => ({
    scope, activationId: id, workflowNodeId: nodeId, lineageId: scope.runId, cause,
  })
  const reviewer = add('reviewer-original', 'node-reviewer', {
    kind: 'entry', activation: activation('entry', 'node-reviewer', { kind: 'entry' }),
  })
  function request(id: string, source: HarnessExecution, destination: string, destinationNodeId: string): WorkRequest {
    const value = { scope, requestId: id, relationshipId: 'execution-edge',
      requesterActivationId: WorkActivationInputSchema.parse(source.input).work.activation.activationId,
      requesterExecutionId: source.id, destinationActivationId: destination, requesterNodeId: source.workflowNodeId,
      destinationNodeId, payloadDigest: repeatDigest(source.result, 64 * 1024), acceptedAt: base.createdAt,
      ordinal: requests.size + 1 }
    requests.set(id, value)
    return value
  }
  const first = request('first-request', reviewer, 'worker-first', 'node-worker')
  const worker = add('worker-original', 'node-worker', { kind: 'work_request',
    activation: activation('worker-first', 'node-worker', { kind: 'work_request', requestId: first.requestId }),
    request: first, acceptedSourceResult: reviewer.result! }, { accepted: false })
  const sql = { async query(statement: string, values: unknown[]) {
    if (statement.includes('select work_parent_request')) {
      const activationId = String(values[1])
      const request = [...requests.values()].find((item) => item.destinationActivationId === activationId)
      return { rows: [{ request_id: parentBindings.get(activationId) ?? request?.requestId ?? null }] }
    }
    if (statement.includes('from runs r join workflow_versions')) return { rows: [{ run_record: base.run,
      version_record: version, run_id: scope.runId, workspace_id: scope.workspaceId,
      workflow_id: scope.workflowId, workflow_version_id: version.id }] }
    if (statement.includes('join run_repeat_executions')) return { rows: rows.has(String(values[0]))
      ? [rows.get(String(values[0]))] : [] }
    if (statement.includes('from run_work_results')) {
      const execution = executions.get(String(values[1]))
      const work = execution && WorkActivationInputSchema.parse(execution.input).work
      return { rows: work?.activation.activationId === values[2] && receipts.has(String(values[1]))
        ? [receipts.get(String(values[1]))] : [] }
    }
    let records: Map<string, unknown> = denials
    if (statement.includes('from run_work_requests')) records = requests
    if (statement.includes('from run_work_returns')) records = returns
    return { rows: records.has(String(values[1])) ? [{ record: records.get(String(values[1])) }] : [] }
  } } as unknown as GraphSqlClient
  function select(execution = worker) {
    return new PostgresRepeatReviewerBindings(sql).select({ workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId, executionId: execution.id,
      requestingAgentId: execution.agentId, nativeSessionId: execution.nativeSessionId!,
      harness: 'codex', approval: base.version.approval }, 'node-reviewer')
  }
  return { add, activation, request, select, reviewer, worker, rows, receipts, returns, denials,
    parentBindings, scope, base }
}

describe('handoff approval reviewer binding', () => {
  it('uses the accepted request source even when another reviewer activation exists', async () => {
    const f = fixture()
    f.add('reviewer-unrelated', 'node-reviewer', {
      kind: 'entry', activation: f.activation('other-entry', 'node-reviewer', { kind: 'entry' }),
    })
    expect((await f.select()).execution.id).toBe(f.reviewer.id)
  })

  it('binds a reactivated Worker to the reviewer that issued that business request', async () => {
    const f = fixture()
    const reviewer = f.add('reviewer-reactivated', 'node-reviewer', {
      kind: 'entry', activation: f.activation('reactivated-entry', 'node-reviewer', { kind: 'entry' }),
    })
    const request = f.request('second-request', reviewer, 'worker-second', 'node-worker')
    const worker = f.add('worker-reactivated', 'node-worker', { kind: 'work_request',
      activation: f.activation('worker-second', 'node-worker', { kind: 'work_request', requestId: request.requestId }),
      request, acceptedSourceResult: reviewer.result! }, { accepted: false })
    expect((await f.select(worker)).execution.id).toBe(reviewer.id)
    expect((await f.select()).execution.id).toBe(f.reviewer.id)
  })

  it.each(['execution_activation_id', 'identity_activation_id', 'slot_id'] as const)(
    'rejects conflicting physical %s', async (field) => {
      const f = fixture()
      f.rows.get(f.worker.id)![field] = 'wrong-activation'
      await expect(f.select()).rejects.toMatchObject({ code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
    })

  it('requires the reviewer accepted-result receipt and matching digest', async () => {
    const f = fixture()
    f.rows.get(f.reviewer.id)!.accepted = false
    await expect(f.select()).rejects.toMatchObject({ code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
    f.rows.get(f.reviewer.id)!.accepted = true
    f.receipts.get(f.reviewer.id)!.result_digest = `sha256:${'f'.repeat(64)}`
    await expect(f.select()).rejects.toMatchObject({ code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
    f.receipts.delete(f.reviewer.id)
    await expect(f.select()).rejects.toMatchObject({ code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
  })

  it.each([false, true])('keeps the parent Worker review owner after a child returns changes (nested=%s)', async (nested) => {
    const f = fixture()
    const workerWork = WorkActivationInputSchema.parse(f.worker.input).work
    const parent = f.add('worker-parent', 'node-worker', workerWork)
    const request = f.request('child-request', parent, 'child-review', 'node-reviewer')
    let child = f.add('reviewer-child', 'node-reviewer', { kind: 'work_request',
      activation: f.activation('child-review', 'node-reviewer', { kind: 'work_request', requestId: request.requestId }),
      request, acceptedSourceResult: parent.result! }, { result: { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: ['fix'] },
      } } })
    const childActivationId = nested ? 'child-review-revised' : 'child-review'
    if (nested) {
      const delegated = f.request('nested-request', child, 'nested-worker', 'node-worker')
      const feedback = f.add('nested-worker-execution', 'node-worker', { kind: 'work_request',
        activation: f.activation('nested-worker', 'node-worker', { kind: 'work_request', requestId: delegated.requestId }),
        request: delegated, acceptedSourceResult: child.result! })
      const revision = { scope: f.scope, returnId: 'nested-return', requestId: delegated.requestId,
        sourceActivationId: 'nested-worker', sourceExecutionId: feedback.id, requesterActivationId: 'child-review',
        continuationActivationId: childActivationId, acceptedResultDigest: repeatDigest(feedback.result, 64 * 1024),
        outcome: 'needs_changes' as const, latestDeliverable: { revision: 1 }, remainingFindings: ['fix'],
        returnedAt: f.base.createdAt }
      f.returns.set(revision.returnId, revision)
      f.parentBindings.set(childActivationId, request.requestId)
      child = f.add('reviewer-child-revised', 'node-reviewer', { kind: 'work_return',
        activation: f.activation(childActivationId, 'node-reviewer', { kind: 'work_return', returnId: revision.returnId }),
        returned: revision, acceptedSourceResult: feedback.result! }, { result: child.result! })
    }
    const returned = { scope: f.scope, returnId: 'child-return', requestId: request.requestId,
      sourceActivationId: childActivationId, sourceExecutionId: child.id, requesterActivationId: 'worker-first',
      continuationActivationId: 'worker-fixes', acceptedResultDigest: repeatDigest(child.result, 64 * 1024),
      outcome: 'needs_changes' as const, latestDeliverable: { revision: 1 }, remainingFindings: ['fix'],
      returnedAt: f.base.createdAt }
    f.returns.set(returned.returnId, returned)
    const continuation = f.add('worker-continuation', 'node-worker', { kind: 'work_return',
      activation: f.activation('worker-fixes', 'node-worker', { kind: 'work_return', returnId: returned.returnId }),
      returned, acceptedSourceResult: child.result! }, { accepted: false })
    expect((await f.select(continuation)).execution.id).toBe(f.reviewer.id)
  })

  it('keeps the Worker review owner when an exhausted handoff delivers a continuation notice', async () => {
    const f = fixture()
    const parent = f.add('worker-before-denial', 'node-worker', WorkActivationInputSchema.parse(f.worker.input).work)
    const denial = { scope: f.scope, denialId: 'review-denial', requestId: 'denied-request',
      relationshipId: 'execution-edge', requesterActivationId: 'worker-first', requesterExecutionId: parent.id,
      destinationNodeId: 'node-reviewer', payloadDigest: repeatDigest(parent.result, 64 * 1024),
      used: 1, maxWorkHandoffsPerRun: 1, deniedAt: f.base.createdAt }
    f.denials.set(denial.denialId, denial)
    const continuation = f.add('worker-after-denial', 'node-worker', { kind: 'limit_denial',
      activation: f.activation('worker-notice', 'node-worker', { kind: 'limit_denial', denialId: denial.denialId }),
      denial, acceptedSourceResult: parent.result!, notice: { scope: f.scope, noticeId: 'limit-notice',
        requesterActivationId: 'worker-first', cause: { kind: 'limit_denial', denialId: denial.denialId },
        continuationActivationId: 'worker-notice', relationshipId: 'execution-edge', destinationNodeId: 'node-reviewer',
        destinationAgentId: f.reviewer.agentId, destinationName: 'Reviewer', used: 1, maxWorkHandoffsPerRun: 1,
        latestDeliverable: { revision: 1 }, remainingFindings: [], alternatives: [],
        message: workLimitNoticeText('Reviewer', 1, 1), delivery: 'queued',
        createdAt: f.base.createdAt, updatedAt: f.base.createdAt } }, { accepted: false })
    expect((await f.select(continuation)).execution.id).toBe(f.reviewer.id)
  })
})
