import { HierarchyReportSchema, type HierarchyReport } from '@foreman-code/contracts'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

/** Call inside the transaction that commits the corresponding authoritative lifecycle/result fact. */
export async function appendHierarchyReportLocked(sql: GraphTransactionSql, raw: HierarchyReport): Promise<HierarchyReport> {
  const report = HierarchyReportSchema.parse(raw)
  const { agent, execution } = report
  // Assign cursor order only while holding the same Run lock as its lifecycle owner.
  await sql.query('select id from runs where id=$1 for no key update', [execution.runId])
  const pin = (await sql.query<{ valid: boolean }>(`select true as valid
    from runs r join workflow_versions v on v.id=r.workflow_version_id
    join harness_executions e on e.run_id=r.id and e.id=$4
    join run_work_requests request on request.run_id=r.id and request.request_id=$5
    join agent_configuration_versions config on config.id=$12 and config.agent_id=$11 and config.workspace_id=$2
    where r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3 and v.id=$6
      and e.workflow_node_id=$7 and e.record->>'attempt'=$8
      and ($9::text is null or e.work_activation_id=$9)
      and request.destination_node_id=$7
      and (request.destination_activation_id=e.work_activation_id or request.request_id=work_parent_request(r.id,e.work_activation_id))
      and e.agent_id=$11 and e.record->>'agentConfigurationVersionId'=$12
      and config.record->>'productRole'=$13
      and exists(select 1 from jsonb_array_elements(v.record #> '{definition,nodes}') node
        where node->>'id'=$7 and node->>'agentId'=$11
          and coalesce(node->>'name',node->>'label',node->>'id')=$14)
      and exists(select 1 from jsonb_array_elements(v.record #> '{definition,hierarchy,parents}') parent
        where parent->>'workflowNodeId'=$7 and parent->>'parentNodeId'=$10)
      and v.record #>> array['agentConfigurationVersionIds',$11]=$12`,
  [execution.runId, agent.workspaceId, agent.workflowId, execution.executionId, report.parentRequestId,
    execution.workflowVersionId, agent.workflowNodeId, String(execution.attempt), execution.activationId ?? null,
    report.parentNodeId, agent.agentId, agent.configurationVersionId, agent.productRole, agent.displayName])).rows[0]
  if (!pin) throw new DomainError('HIERARCHY_REPORT_SOURCE_CONFLICT', 'The report does not match its committed Run, execution and parent request.', 409)
  await sql.query(`insert into run_hierarchy_reports(id,workspace_id,workflow_id,run_id,workflow_version_id,
    workflow_node_id,parent_node_id,execution_id,parent_request_id,source_event_key,record)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) on conflict(run_id,source_event_key) do nothing`,
  [report.id, agent.workspaceId, agent.workflowId, execution.runId, execution.workflowVersionId,
    agent.workflowNodeId, report.parentNodeId, execution.executionId, report.parentRequestId,
    report.sourceEventKey, JSON.stringify(report)])
  const stored = (await sql.query<{ record: unknown }>(
    'select record from run_hierarchy_reports where run_id=$1 and source_event_key=$2',
    [execution.runId, report.sourceEventKey])).rows[0]
  const accepted = HierarchyReportSchema.parse(stored?.record)
  if (!sameWorkflowValue(accepted, report)) throw new DomainError('HIERARCHY_REPORT_SOURCE_CONFLICT',
    'The source event already has a different committed report.', 409)
  return accepted
}
