import { DurableInteractionSchema, HarnessExecutionSchema, WorkDirectionRequestSchema,
  type ApprovalResponseOption } from '@foreman-code/contracts'
import { parseWorkHandoffResult, type AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import type { RunGraphPublication } from '../run-graph/publication.js'
import { graphSourceDigest } from '../run-graph/publication.js'
import { approvalAttentionFacts } from '../interactions/wave25/attention.js'
import { interactionFact } from '../interactions/wave25/publication.js'
import { DomainError } from '../errors.js'
import { readAcceptedRepeatRunLocked } from './repeatStartRead.js'
import { parseWorkflowWorkResult } from './workflowCoordinationResult.js'

export const workDirectionInteractionId = (runId: string) => `work-direction-${runId}`

const option = (optionId: string, label: string, semantic: ApprovalResponseOption['semantic']): ApprovalResponseOption => ({
  optionId, label, semantic, persistence: 'request', affectsOtherPendingRequests: false,
  interruptsCurrentTurn: false, mutatesPersistentPolicy: false,
})

/** Publish both newly reached waits and waits retained before this interaction existed. */
export async function ensureWorkDirectionInteraction(publication: RunGraphPublication, run: AcceptedWorkflowRunV3): Promise<void> {
  const sql = publication.sql
  const id = workDirectionInteractionId(run.id)
  if ((await sql.query('select 1 from durable_interactions where id=$1', [id])).rowCount) return
  const rows = (await sql.query<{ unresolved_id: string; reason: string; record: unknown }>(`
    select u.unresolved_id,u.reason,e.record from run_work_unresolved u
      join harness_executions e on e.id=u.execution_id and e.run_id=u.run_id
    where u.run_id=$1 order by u.unresolved_id limit 1001`, [run.id])).rows
  if (!rows.length || rows.length > 1000) throw new DomainError(
    'WORK_DIRECTION_WAIT_CONFLICT', 'The Run has no readable direction wait.', 409)
  const executions = rows.map((row) => HarnessExecutionSchema.parse(row.record))
  const snapshot = run.resultProtocol ? await readAcceptedRepeatRunLocked(sql, run.id) : undefined
  const requester = executions[0]!
  const config = (await sql.query<{ harness: string }>(
    "select record#>>'{harness,harness}' as harness from agent_configuration_versions where id=$1",
    [requester.agentConfigurationVersionId])).rows[0]!
  const request = WorkDirectionRequestSchema.parse({
    message: 'The agents finished with unresolved work. Accept the remaining findings, continue with direction, or stop.',
    unresolved: rows.map((row, index) => {
      const execution = executions[index]!
      const result = snapshot ? parseWorkflowWorkResult(execution.result!, snapshot.version,
        execution.workflowNodeId, run.resultProtocol) : parseWorkHandoffResult(execution.result)
      return { unresolvedId: row.unresolved_id, executionId: execution.id, reason: row.reason,
        latestDeliverable: result.data.latestDeliverable, remainingFindings: result.data.remainingFindings }
    }),
  })
  const now = new Date().toISOString()
  const interaction = DurableInteractionSchema.parse({
    kind: 'work_direction', id, revision: 0, workspaceId: run.workspaceId, workflowId: run.workflowId,
    runId: run.id, executionId: requester.id, requestingAgentId: requester.agentId,
    harness: config.harness, providerVersion: 'workflow', nativeSessionId: requester.nativeSessionId ?? run.id,
    nativeRequestId: id, nativeRequestType: 'workflow/work_direction', graphThreadId: run.id,
    request, approval: { handler: 'user' }, responseOptions: [
      option('finish', 'Finish Run and accept remaining findings', 'approve_once'),
      { ...option('continue', 'Continue in a new Run', 'approve_once'),
        scopeSummary: 'Runs the same saved workflow with your direction and the recorded findings.',
        input: { kind: 'form', schema: { type: 'object', properties: {
          direction: { type: 'string', title: 'Direction for the agents', minLength: 1, maxLength: 16000 },
        }, required: ['direction'], additionalProperties: false } } },
      option('stop', 'Stop Run', 'cancel'),
    ], status: 'pending', deliveryState: 'not_started', createdAt: now, updatedAt: now,
  })
  const context = { scope: publication.scope, requester, stopped: false }
  await publication.source({ evidence: { sourceKind: 'interaction', sourceId: id, sourceRevision: '0' },
    sourceDigest: graphSourceDigest(interaction), facts: [interactionFact(context, interaction),
      ...await approvalAttentionFacts(sql, context, { interaction })] }, async (transaction) => {
    await transaction.query(`insert into durable_interactions
      (id,workspace_id,workflow_id,run_id,execution_id,requesting_agent_id,harness,
       native_session_id,native_request_id,status,revision,record)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',0,$10::jsonb)`,
    [id, run.workspaceId, run.workflowId, run.id, requester.id, requester.agentId,
      interaction.harness, interaction.nativeSessionId, id, JSON.stringify(interaction)])
  })
}
