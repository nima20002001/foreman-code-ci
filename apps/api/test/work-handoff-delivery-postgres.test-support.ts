import assert from 'node:assert/strict'
import pg from 'pg'
import { ExecutionResultSchema, HarnessExecutionSchema, type HarnessExecution, type ExecutionResult } from '@foreman-code/contracts'
import {
  WorkActivationInputSchema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture, canonicalGraphJson, type WorkHandoffResult,
} from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import type { RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { assertWorkHandoffDeliveryLocked } from '../src/modules/runs/workHandoffDelivery.js'
import { createWorkLimitNotice } from '../src/modules/runs/workHandoffNotice.js'
import { repeatDigest, repeatId } from '../src/modules/runs/repeatResolution.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { transaction } from './eng04-migration-fixtures.js'

export const text = (value: unknown) => canonicalGraphJson(value, 4 * 1024 * 1024)

export async function databaseJsonBytes(pool: pg.Pool, value: unknown): Promise<number> {
  const result = await pool.query<{ bytes: number }>('select work_json_bytes($1::jsonb) as bytes', [text(value)])
  return result.rows[0]!.bytes
}

export async function boundaryNoticeDeliverable(pool: pg.Pool,
  notice: ReturnType<typeof createWorkLimitNotice>, payload: 'text' | 'numeric') {
  const prefix = 'deliverable with spaces, "quotes", \\slashes and a newline\n'
  const numbers = Array<number>(600).fill(1e100)
  const latestDeliverable = payload === 'numeric' ? { numbers, text: prefix } : prefix
  const delivered = { ...notice, latestDeliverable, delivery: 'delivered', acknowledgementId: 'a'.repeat(200) }
  const used = await databaseJsonBytes(pool, delivered)
  const padded = prefix + 'x'.repeat(65536 - used)
  return payload === 'numeric' ? { numbers, text: padded } : padded
}

export async function acquireOwner(pool: pg.Pool, runId: string): Promise<RunOwnership> {
  const owner = await RunOwnership.acquire(pool, runId, () => undefined)
  assert.ok(owner)
  return owner
}

// Start at the committed terminal-acceptance boundary. Native settlement and
// publication are fixture ports; return correlation and persistence use real SQL.
export async function acceptedReview(pool: pg.Pool, output: WorkHandoffResult,
  options: { reviewAccepted: boolean } = { reviewAccepted: true }) {
  const fixture = makeCurrentWorkflowFixture('review-delivery')
  const source = agentWorkflowNode(fixture.version.definition.nodes[0])
  const reviewer = agentWorkflowNode(fixture.version.definition.nodes[1])
  const edge = fixture.version.definition.edges[0]!
  const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
    ...fixture.version.definition, handoffs: { contractVersion: 1 },
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 10 },
    edges: [{ ...edge, maxWorkHandoffsPerRun: 1 }],
    nodes: [{ ...source, choice: { outcomes: [
      { outcome: 'review', target: { kind: 'edge', relationshipId: edge.id } },
    ] } }, reviewer],
  } })
  const run = { ...fixture.run, executionState: 'running' as const }
  const requestId = output.routing.kind === 'return' ? output.routing.requestId : 'review-request'
  const sourceResult: ExecutionResult = { outcome: 'succeeded', output: {
    routing: { kind: 'request', outcome: 'review' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
  } }
  const request = { scope: fixture.scope, requestId, relationshipId: edge.id,
    requesterActivationId: 'requester-activation', requesterExecutionId: 'requester-execution',
    destinationActivationId: 'review-activation', requesterNodeId: source.id, destinationNodeId: reviewer.id,
    payloadDigest: repeatDigest(sourceResult), acceptedAt: fixture.createdAt, ordinal: 1 }
  const executions: HarnessExecution[] = []
  await transaction(pool, async (sql) => {
    await sql.query('insert into workspaces(id,record) values($1,$2::jsonb)', [run.workspaceId, text({ id: run.workspaceId })])
    await sql.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [run.workflowId, run.workspaceId, text({ id: run.workflowId, workspaceId: run.workspaceId })])
    for (const config of fixture.configurations) {
      await sql.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
        [config.agentId, run.workspaceId, text({ id: config.agentId, workspaceId: run.workspaceId })])
      await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
        values($1,$2,$3,1,$4::jsonb)`, [config.id, run.workspaceId, config.agentId, text(config)])
    }
    await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
      values($1,$2,$3,1,$4,3,$5::jsonb)`, [version.id, run.workspaceId, run.workflowId, version.entryNodeId, text(version)])
    await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values($1,$2,$3,$4,'running',$5::jsonb)`, [run.id, run.workspaceId, run.workflowId, version.id, text(run)])
    for (const [index, node] of [source, reviewer].entries()) {
      const activationId = index ? request.destinationActivationId : request.requesterActivationId
      const executionId = index ? 'review-execution' : request.requesterExecutionId
      const cause = index ? { kind: 'work_request', requestId } : { kind: 'entry' }
      const activation = { scope: fixture.scope, activationId, workflowNodeId: node.id, lineageId: run.id, cause }
      await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
        cause_kind,cause_id,state,record) values($1,$2,$3,$4,$5,$6,'completed',$7::jsonb)`,
        [activationId, run.id, version.id, node.id, cause.kind, index ? requestId : run.id, text(activation)])
      const result = index ? ExecutionResultSchema.parse({ outcome: 'succeeded', output }) : sourceResult
      const input = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: run.input,
        occurrence: null, entry: null, predecessors: [], work: index
          ? { kind: 'work_request', activation, request, acceptedSourceResult: sourceResult }
          : { kind: 'entry', activation } })
      const execution = HarnessExecutionSchema.parse({ id: executionId, runId: run.id, workflowNodeId: node.id,
        agentId: node.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
        attempt: 1, input, state: 'completed', result, createdAt: fixture.createdAt, finishedAt: fixture.createdAt })
      await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
        values($1,$2,$3,$4,1,$5,$6::jsonb,$7)`,
        [executionId, run.id, node.id, node.agentId, index ? options.reviewAccepted : true, text(execution), activationId])
      if (!index || options.reviewAccepted) await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
        values($1,$2,$3,$4,$5,$6)`, [executionId, run.id, activationId, text(result), repeatDigest(result), fixture.createdAt])
      executions.push(execution)
    }
    await sql.query(`insert into run_work_connection_usage(run_id,workflow_version_id,relationship_id,used,maximum)
      values($1,$2,$3,1,1)`, [run.id, version.id, edge.id])
    await sql.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,
      requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,
      ordinal,payload_digest,record,accepted_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11::jsonb,$12)`, [requestId, run.id, version.id, edge.id,
      request.requesterActivationId, request.requesterExecutionId, request.destinationActivationId,
      source.id, reviewer.id, request.payloadDigest, text(request), fixture.createdAt])
  })

  const host: RepeatRepositoryHost = { openLocked: async () => ({ run,
    assertAuthorityLocked: async () => undefined, assertAdmissionLocked: async () => undefined,
    assertSettlementLocked: async () => undefined, allowTechnicalRetryLocked: async () => false,
    publishLocked: async () => { throw new Error('Unexpected native publication') },
    assertPublicationReceiptLocked: async () => { throw new Error('Unexpected native publication read') },
    completeRunLocked: async () => { throw new Error('Run lifecycle belongs to the settlement fixture') },
  }) }
  return { fixture, version, run, host, request, executions }
}

export async function pendingRequester(pool: pg.Pool, t: Awaited<ReturnType<typeof acceptedReview>>,
  output: WorkHandoffResult) {
  const activationId = 'requester-next-activation'
  const execution = HarnessExecutionSchema.parse({ ...t.executions[0], id: 'requester-next-execution',
    result: { outcome: 'succeeded', output } })
  const activation = { scope: t.fixture.scope, activationId, workflowNodeId: execution.workflowNodeId,
    lineageId: t.run.id, cause: { kind: 'dependency', resolutionId: 'completed-review' } }
  await pool.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
    cause_kind,cause_id,state,record) values($1,$2,$3,$4,'dependency','completed-review','queued',$5::jsonb)`,
    [activationId, t.run.id, t.version.id, execution.workflowNodeId, text(activation)])
  await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
    values($1,$2,$3,$4,1,false,$5::jsonb,$6)`, [execution.id, t.run.id, execution.workflowNodeId,
    execution.agentId, text(execution), activationId])
  return { activationId, execution }
}

export async function acceptPreparedResult(sql: GraphTransactionSql,
  t: Awaited<ReturnType<typeof acceptedReview>>, activationId: string,
  execution: HarnessExecution, output: WorkHandoffResult) {
  await sql.query('select id from runs where id=$1 for update', [t.run.id])
  await assertWorkHandoffDeliveryLocked({ sql, scope: t.fixture.scope, version: t.version,
    now: t.fixture.createdAt }, execution, activationId, output)
  await sql.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1', [execution.id, text(execution)])
  await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
    values($1,$2,$3,$4,$5,$6)`, [execution.id, t.run.id, activationId,
    text(execution.result), repeatDigest(execution.result), t.fixture.createdAt])
  await sql.query("update run_work_activations set state='completed' where activation_id=$1 and run_id=$2", [activationId, t.run.id])
}

export function returnPreview(t: Awaited<ReturnType<typeof acceptedReview>>, output: WorkHandoffResult) {
  assert.equal(output.routing.kind, 'return')
  if (output.routing.kind !== 'return') throw new Error('Return fixture required')
  const returnId = repeatId('work-return', 'review-execution')
  return { scope: t.fixture.scope, returnId, requestId: t.request.requestId,
    sourceActivationId: t.request.destinationActivationId, sourceExecutionId: 'review-execution',
    requesterActivationId: t.request.requesterActivationId,
    ...(output.routing.outcome === 'needs_changes'
      ? { continuationActivationId: repeatId('work-activation', returnId) } : {}),
    acceptedResultDigest: repeatDigest(t.executions[1]!.result), outcome: output.routing.outcome,
    latestDeliverable: output.data.latestDeliverable, remainingFindings: output.data.remainingFindings,
    returnedAt: t.fixture.createdAt }
}

