import { AgentConfigurationVersionSchema, AgentIdentitySchema, HarnessExecutionSchema,
  type AgentSubject, type LogicalWorkRef } from '@foreman-code/contracts'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

export async function memoryExecution(tx: GraphTransactionSql, executionId: string) {
  const row = (await tx.query<{
    execution: unknown; version: unknown; configuration: unknown; slot_id: string;
    work_activation_id: string | null; accepted: boolean; previous_execution_id: string | null;
    run_outcome: string; run_reason: string | null;
  }>(`select e.record as execution,v.record as version,c.record as configuration,
      x.slot_id,x.work_activation_id,e.accepted,x.previous_execution_id,
      r.record->>'outcome' as run_outcome,r.record#>>'{result,error,message}' as run_reason
    from harness_executions e join runs r on r.id=e.run_id
    join workflow_versions v on v.id=r.workflow_version_id
    join run_repeat_executions x on x.execution_id=e.id and x.run_id=r.id
    join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
      and c.agent_id=e.agent_id and c.workspace_id=r.workspace_id
    where e.id=$1`, [executionId])).rows[0]
  if (!row) throw new DomainError('NOT_FOUND', 'The saved workflow execution is unavailable.', 404)
  const execution = HarnessExecutionSchema.parse(row.execution)
  const version = WorkflowVersionV3Schema.parse(row.version)
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
  const node = version.definition.nodes.find(candidate => candidate.id === execution.workflowNodeId)
  if (!node || node.kind === 'job' || node.agentId !== execution.agentId
    || version.agentConfigurationVersionIds[execution.agentId] !== configuration.id) {
    throw new DomainError('EXECUTION_IDENTITY_CONFLICT', 'The execution does not match its saved Agent.', 409)
  }
  const agent = AgentIdentitySchema.parse({ workspaceId: version.workspaceId, workflowId: version.workflowId,
    workflowNodeId: node.id, agentId: execution.agentId, productRole: configuration.productRole,
    displayName: node.name ?? node.label ?? node.id, configurationVersionId: configuration.id })
  const reference = { runId: execution.runId, workflowVersionId: version.id, executionId: execution.id,
    attempt: execution.attempt, ...(row.work_activation_id ? { activationId: row.work_activation_id } : {}) }
  const work: LogicalWorkRef = row.work_activation_id
    ? { kind: 'activation', runId: execution.runId, workflowVersionId: version.id, activationId: row.work_activation_id }
    : { kind: 'slot', runId: execution.runId, workflowVersionId: version.id, slotId: row.slot_id }
  const subject: AgentSubject = { kind: 'execution', agent, execution: reference }
  return { execution, version, configuration, node, subject, work, accepted: row.accepted,
    previousExecutionId: row.previous_execution_id, runOutcome: row.run_outcome, runReason: row.run_reason }
}

