import type { SqlQuery } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { withGitDirectoryDependencies } from '../workspaces/gitDirectoryDependencies.js'

export async function assertNoActiveAgentChats(sql: SqlQuery, workspaceIds: string[]): Promise<void> {
  const active = await sql.query(`select 1 from operator_conversations c
    where c.kind='agent' and c.workspace_id=any($1::text[])
      and (c.active_request_id is not null or exists(
        select 1 from operator_conversation_turns t where t.conversation_id=c.id
          and t.delivery in ('queued','submitting','accepted','unknown'))) limit 1`, [workspaceIds])
  if (active.rows.length) {
    throw new DomainError('ARCHIVE_BLOCKED_BY_ACTIVE_CHAT',
      'Settle queued and active Agent chat messages before archiving the workspace.', 409)
  }
}

export async function activeAgentChatDirectories(sql: SqlQuery): Promise<string[]> {
  const result = await sql.query<{ path: string }>(`select c.record->>'workingDirectory' as path
    from operator_conversations c
    left join agent_configuration_versions v on v.id=c.agent_configuration_version_id
    left join run_node_placements p on p.run_id=c.origin_run_id and p.node_id=c.workflow_node_id
    where c.kind='agent'
      and coalesce(p.record#>>'{hostRef,kind}',
        c.worker_conversation_binding#>>'{profile,target,hostRef,kind}',
        c.record#>>'{directoryBinding,placement,hostRef,kind}',
        v.record#>>'{harnessProfileSelection,target,hostRef,kind}', 'main')='main'
      and (c.active_request_id is not null or exists(
        select 1 from operator_conversation_turns t where t.conversation_id=c.id
          and t.delivery in ('queued','submitting','accepted','unknown')))`)
  return withGitDirectoryDependencies(result.rows.map(row => row.path))
}
