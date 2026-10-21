import { isDeepStrictEqual } from 'node:util'
import {
  AgentConfigurationVersionSchema, HarnessExecutionSchema,
  WorkflowControlContinuationSchema, type HarnessExecution, type WorkflowSessionContinuation,
} from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { readWorkflowClosure } from '../interactions/workflowClosure.js'
import { readDispatchIntent, readExecutionPlacement } from '../placement/persistence.js'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { repeatConflict, repeatTickIndex } from './repeatResolution.js'

function sameSessionWork(previous: HarnessExecution, execution: HarnessExecution,
  placements: { previous?: Pick<AcceptedNodePlacement, 'bindingHash'> | undefined;
    current?: Pick<AcceptedNodePlacement, 'bindingHash'> | undefined }): boolean {
  return previous.id !== execution.id && previous.runId === execution.runId
    && previous.workflowNodeId === execution.workflowNodeId && previous.agentId === execution.agentId
    && previous.agentConfigurationVersionId === execution.agentConfigurationVersionId
    && previous.state === 'completed' && previous.nativeSessionId !== undefined
    && previous.workingDirectory !== undefined && previous.workingDirectory === execution.workingDirectory
    && isDeepStrictEqual(previous.systemPrompt, execution.systemPrompt)
    && placements.previous?.bindingHash === placements.current?.bindingHash
}

export function canContinueWorkflowSession(previous: HarnessExecution, execution: HarnessExecution,
  placements: { previous?: Pick<AcceptedNodePlacement, 'bindingHash'> | undefined;
    current?: Pick<AcceptedNodePlacement, 'bindingHash'> | undefined } = {}): boolean {
  // Retryable or canceled attempts start fresh; a deliberate failure keeps its context for routed retries.
  if (previous.result?.error?.retryable === true || previous.result?.outcome === 'canceled') return false
  if (repeatTickIndex(previous.input) !== undefined && previous.result?.outcome !== 'succeeded') return false
  return sameSessionWork(previous, execution, placements)
}

/** Select history while the Run's launch transaction holds its owner lock. */
export async function readWorkflowSessionContinuation(sql: GraphTransactionSql,
  execution: HarnessExecution): Promise<WorkflowSessionContinuation | undefined> {
  const control = (await sql.query<{ record: unknown; previous_execution_id: string }>(
    `select record,previous_execution_id from run_control_continuations
      where run_id=$1 and successor_execution_id=$2 and state='admitted'`, [execution.runId, execution.id])).rows[0]
  const row = (await sql.query<{ record: unknown; configuration: unknown }>(`select e.record,c.record as configuration
    from harness_executions e join agent_configuration_versions c
      on c.id=e.record->>'agentConfigurationVersionId'
    where e.run_id=$1 and e.workflow_node_id=$2 and e.id<>$3 and ($4::text is null or e.id=$4)
    order by e.created_at desc,e.id desc limit 1 for share of e,c`,
  [execution.runId, execution.workflowNodeId, execution.id, control?.previous_execution_id ?? null])).rows[0]
  if (!row) return undefined
  const previous = HarnessExecutionSchema.parse(row.record)
  const continuation = control ? WorkflowControlContinuationSchema.parse(control.record) : undefined
  if (continuation && (continuation.previousExecution.executionId !== previous.id
    || continuation.successorExecution?.executionId !== execution.id
    || continuation.nativeTarget.nativeSessionId !== previous.nativeSessionId
    || continuation.successorExecution.attempt !== execution.attempt)) return repeatConflict('CONTROL_SUCCESSOR_CONFLICT')
  const eligible = continuation ? sameSessionWork : canContinueWorkflowSession
  if (!eligible(previous, execution, {})) return undefined
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
  if (configuration.harness.harness === 'codex'
    && configuration.harness.advanced?.sessionPersistence === 'ephemeral') return undefined
  const previousPlacement = await readExecutionPlacement(sql, previous.id)
  const placement = await readExecutionPlacement(sql, execution.id)
  if (!eligible(previous, execution, { previous: previousPlacement, current: placement })) return undefined
  if (continuation) {
    const slot = (await sql.query<{ same_slot: boolean; previous_accepted: boolean }>(
      `select p.slot_id=n.slot_id as same_slot,e.accepted as previous_accepted
        from run_repeat_executions p join run_repeat_executions n on n.run_id=p.run_id
        join harness_executions e on e.id=p.execution_id and e.run_id=p.run_id
        where p.run_id=$1 and p.execution_id=$2 and n.execution_id=$3`,
      [execution.runId, previous.id, execution.id])).rows[0]
    if (!slot?.same_slot || slot.previous_accepted) return repeatConflict('CONTROL_SUCCESSOR_CONFLICT')
  }
  const closure = await readWorkflowClosure(sql, previous)
  if (!closure || closure.session.harness !== configuration.harness.harness) return undefined
  const intent = await readDispatchIntent(sql, previous.id)
  return {
    previousExecutionId: previous.id,
    session: closure.session,
    ...(intent ? { previousOperationId: intent.operationId } : {}),
  }
}
