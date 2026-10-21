import { canonicalJson, effectiveGraphqlTools, type AgentConfigurationVersion,
  type ChatSendRequest } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { workflowChatInputPrompt } from '../interactions/workflowChatInput.js'
import { readWorkflowCollaborationPromptLocked } from './workflowPreparation.js'
import type { WorkflowChatLockedTarget } from './workflowControlTypes.js'

/** Admission reads a bounded snapshot through the existing Run transaction.
 * The completed delegation supplies identity and its already-authorized memory
 * snapshot; it supplies no new graph-result or child-return authority. */
export async function workflowConsultationPromptLocked(context: WorkflowChatLockedTarget,
  request: ChatSendRequest, configuration: AgentConfigurationVersion): Promise<string> {
  const waiting = context.waiting
  if (context.target.kind !== 'workflow_coordinator' || !waiting
    || configuration.id !== context.agent.configurationVersionId
    || configuration.agentId !== context.agent.agentId) throw new DomainError(
    'COORDINATOR_BINDING_CONFLICT', 'The consultation prompt requires the exact waiting coordinator.', 409)
  const reports = (await context.sql.query<{ record: Record<string, unknown> }>(`select jsonb_build_object(
      'reportId',r.id,'requestId',r.parent_request_id,'nodeId',r.workflow_node_id,
      'state',r.record->>'state','summary',left(r.record->>'summary',600),
      'updatedAt',r.record->>'updatedAt') as record from run_hierarchy_reports r
    join run_hierarchy_group_members m on m.run_id=r.run_id and m.request_id=r.parent_request_id
    where r.run_id=$1 and m.group_id=$2 and r.parent_node_id=$3
    order by r.sequence desc limit 33`, [context.run.id, waiting.delegationGroupId,
    context.agent.workflowNodeId])).rows
  const children = (await context.sql.query<{ record: Record<string, unknown> }>(`select jsonb_build_object(
      'requestId',q.request_id,'nodeId',q.destination_node_id,
      'requestState',case when m.failure_execution_id is not null then 'failed'
        when exists(select 1 from run_work_returns t where t.run_id=q.run_id and t.request_id=q.request_id)
        then 'returned' else 'pending' end,
      'failureExecutionId',m.failure_execution_id,'failureCode',m.failure_result #>> '{error,code}',
      'failureSummary',left(m.failure_result #>> '{error,message}',300)) as record
    from run_hierarchy_group_members m join run_work_requests q on q.run_id=m.run_id and q.request_id=m.request_id
    where m.run_id=$1 and m.group_id=$2 order by m.ordinal limit 33`,
  [context.run.id, waiting.delegationGroupId])).rows
  const facts: string[] = []
  let bytes = 0, omitted = 0
  for (const [kind, rows] of [['child', children], ['report', reports]] as const) {
    for (const [index, row] of rows.entries()) {
      const line = canonicalJson({ kind, ...row.record })
      const size = Buffer.byteLength(line, 'utf8') + 1
      if (index >= 32 || bytes + size > 24 * 1024) { omitted++; continue }
      facts.push(line); bytes += size
    }
  }
  const node = context.version.definition.nodes.find(item => item.id === context.agent.workflowNodeId)
  const permitted = node && node.kind !== 'job' && configuration.productRole
    && effectiveGraphqlTools(configuration.productRole, configuration.graphqlTools, node.graphqlTools,
      false, ['memory_board_get']).includes('memory_board_get')
  const digest = permitted
    ? await readWorkflowCollaborationPromptLocked(context.sql, waiting.sourceExecution.executionId) : undefined
  return [
    'Reply to the user as the waiting coordinator in this existing Run.',
    'This reply is a consultation. Do not emit RESULT, route work, return child work, or release the child barrier.',
    'Delegated work continues under its existing requests. You may use only your enabled scoped tools.',
    'Instructions that change delegated work are retained for your next authoritative coordinator continuation.',
    canonicalJson({ runId: context.run.id, workflowVersionId: context.version.id,
      waitingActivationId: waiting.waitingActivationId, delegationGroupId: waiting.delegationGroupId }),
    'Committed child facts at admission (bounded; newer reports may arrive while you reply):',
    ...(facts.length ? facts : ['No child reports have been committed yet.']),
    ...(omitted ? [`At least ${omitted} further child/report records are omitted; inspect scoped current facts as needed.`] : []),
    digest,
    'User input:', workflowChatInputPrompt(request),
  ].filter(Boolean).join('\n\n')
}
