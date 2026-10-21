import { isDeepStrictEqual } from 'node:util'
import {
  AgentConfigurationVersionSchema, HarnessExecutionSchema,
  type HarnessExecution, type WorkflowSessionContinuation,
} from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { readWorkflowClosure } from '../interactions/workflowClosure.js'
import { readDispatchIntent, readExecutionPlacement } from '../placement/persistence.js'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { repeatTickIndex } from './repeatResolution.js'

export function canContinueWorkflowSession(previous: HarnessExecution, execution: HarnessExecution,
  placements: { previous?: Pick<AcceptedNodePlacement, 'bindingHash'> | undefined;
    current?: Pick<AcceptedNodePlacement, 'bindingHash'> | undefined } = {}): boolean {
  // Retryable or canceled attempts start fresh; a deliberate failure keeps its context for routed retries.
  if (previous.result?.error?.retryable === true || previous.result?.outcome === 'canceled') return false
  if (repeatTickIndex(previous.input) !== undefined && previous.result?.outcome !== 'succeeded') return false
  return previous.id !== execution.id && previous.runId === execution.runId
    && previous.workflowNodeId === execution.workflowNodeId && previous.agentId === execution.agentId
    && previous.agentConfigurationVersionId === execution.agentConfigurationVersionId
    && previous.state === 'completed' && previous.nativeSessionId !== undefined
    && previous.workingDirectory !== undefined && previous.workingDirectory === execution.workingDirectory
    && isDeepStrictEqual(previous.systemPrompt, execution.systemPrompt)
    && placements.previous?.bindingHash === placements.current?.bindingHash
}

/** Select history while the Run's launch transaction holds its owner lock. */
export async function readWorkflowSessionContinuation(sql: GraphTransactionSql,
  execution: HarnessExecution): Promise<WorkflowSessionContinuation | undefined> {
  const row = (await sql.query<{ record: unknown; configuration: unknown }>(`select e.record,c.record as configuration
    from harness_executions e join agent_configuration_versions c
      on c.id=e.record->>'agentConfigurationVersionId'
    where e.run_id=$1 and e.workflow_node_id=$2 and e.id<>$3
    order by e.created_at desc,e.id desc limit 1 for share of e,c`,
  [execution.runId, execution.workflowNodeId, execution.id])).rows[0]
  if (!row) return undefined
  const previous = HarnessExecutionSchema.parse(row.record)
  if (!canContinueWorkflowSession(previous, execution)) return undefined
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
  if (configuration.harness.harness === 'codex'
    && configuration.harness.advanced?.sessionPersistence === 'ephemeral') return undefined
  const previousPlacement = await readExecutionPlacement(sql, previous.id)
  const placement = await readExecutionPlacement(sql, execution.id)
  if (!canContinueWorkflowSession(previous, execution, { previous: previousPlacement, current: placement })) return undefined
  const closure = await readWorkflowClosure(sql, previous)
  if (!closure || closure.session.harness !== configuration.harness.harness) return undefined
  const intent = await readDispatchIntent(sql, previous.id)
  return {
    previousExecutionId: previous.id,
    session: closure.session,
    ...(intent ? { previousOperationId: intent.operationId } : {}),
  }
}
