import type pg from 'pg'
import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { AgentConversationRow } from './agentChatRepository.js'
import { resolveAgentChatDirectory } from './agentChatDirectory.js'
import { HANDOFF_MESSAGE_LIMIT, handoffContext } from './operatorChatRepository.js'
import { harnessSessionChanged } from '../harnesses/providerAccountConfiguration.js'
import { DomainError } from '../errors.js'

type Queryable = Pick<pg.PoolClient, 'query'>

export function agentConfigurationTransition(row: AgentConversationRow,
  previous: AgentConfigurationVersion, configuration: AgentConfigurationVersion) {
  const previousProfile = row.worker_conversation_binding
    ? WorkerConversationBindingSchema.parse(row.worker_conversation_binding).profile : previous.harnessProfileSelection
  const profileChanged = previousProfile?.instanceId !== configuration.harnessProfileSelection?.instanceId
    || commandInputHash(previousProfile?.target ?? null)
      !== commandInputHash(configuration.harnessProfileSelection?.target ?? null)
  const ephemeral = previous.harness.harness === 'codex'
    && previous.harness.advanced?.sessionPersistence === 'ephemeral'
  const claudeDirectoryChanged = previous.harness.harness === 'claude' && configuration.harness.harness === 'claude'
    && previous.harness.configDirectory !== configuration.harness.configDirectory
  return { previousProfile, replaceSession: harnessSessionChanged(previous.harness, configuration.harness)
    || ephemeral || profileChanged || claudeDirectoryChanged }
}

export async function agentConfigurationDirectory(sql: Queryable, row: AgentConversationRow,
  configuration: AgentConfigurationVersion) {
  const binding = row.record.directoryBinding
  if (!binding) return undefined
  const profile = configuration.harnessProfileSelection
  const placement = profile ? { ...binding.placement, instanceId: profile.instanceId,
    instanceRevision: profile.instanceRevision, harnessInstallationId: profile.target.harnessInstallationId }
    : binding.placement
  const directory = await resolveAgentChatDirectory({ sql, configuration,
    workflowVersionId: binding.workflowVersionId, placement })
  if (directory.workingDirectory !== row.record.workingDirectory) {
    throw new DomainError('AGENT_CHAT_DIRECTORY_UNAVAILABLE', 'The chat settings changed its saved working folder.', 409)
  }
  return directory.directoryBinding
}

/** Before admission all messages precede the new turn; dispatch excludes its already-persisted message. */
export async function agentConfigurationHandoff(sql: Queryable, conversationId: string, beforeRequestId?: string) {
  const history = await sql.query<{ role: string; content: string }>(`select role,content
    from operator_conversation_messages where conversation_id=$1 and role in ('user','assistant')
    and ($2::text is null or sequence < (select sequence from operator_conversation_messages
      where conversation_id=$1 and client_request_id=$2))
    order by sequence desc limit $3`, [conversationId, beforeRequestId ?? null, HANDOFF_MESSAGE_LIMIT])
  const count = await sql.query<{ count: string }>(`select count(*)::text as count
    from operator_conversation_messages where conversation_id=$1 and role in ('user','assistant')
    and ($2::text is null or sequence < (select sequence from operator_conversation_messages
      where conversation_id=$1 and client_request_id=$2))`, [conversationId, beforeRequestId ?? null])
  return handoffContext(null, 0, history.rows, Number(count.rows[0]!.count), 'Agent').text
}
