import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import type { AgentUpdateInput } from '@foreman-code/contracts/management'
import { applyOperatorChatSettings, operatorChatSettings, type OperatorChatSettings } from '@foreman-code/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys, useHarnessDefaultsQuery, useManagedAgentsQuery } from '../../../shared/api/query'
import { updateManagedAgent } from '../../../shared/api/client'
import { errorMessage } from '../../../shared/errorMessage'
import { useLocalHumanAccessQuery } from '../../../shared/api/settingsExperience'
import { canUseBoardAction } from '../../workflow-board/permissions'
import { OperatorComposerSettings } from '../../operator-chat/OperatorComposerSettings'
import './agentChatSettings.css'

/**
 * The Operator chat's model picker, bound to this Agent. A change saves the Agent through the same
 * revision-checked edit as the Board and the Operator's agent_update, so it creates a new Agent
 * configuration version, applied when the conversation starts its next turn.
 */
export function AgentChatSettings({ context, disabled }: {
  context: AgentChatContext; disabled: boolean
}) {
  const { workspaceId, agentId } = context
  const access = useLocalHumanAccessQuery()
  // UI affordance only; the Agent edit service rechecks every grant.
  const allowed = !!access.data && canUseBoardAction(access.data.principal.grants, 'agents:update', context)
  const agents = useManagedAgentsQuery(workspaceId)
  const defaults = useHarnessDefaultsQuery()
  const client = useQueryClient()
  const save = useMutation({ mutationFn: (input: AgentUpdateInput) => updateManagedAgent(input),
    // The Agent catalog and every workflow editor context listing this Agent now hold a newer configuration version.
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.managedAgents(workspaceId) }),
      client.invalidateQueries({ queryKey: [...queryKeys.managedWorkspace(workspaceId), 'workflow'] }),
    ]) })
  const entry = agents.data?.items.find((item) => item.agent.id === agentId)
  const configuration = entry?.agent.harnessConfiguration
  const versionId = entry?.agent.configurationVersionId
  if (!entry || !configuration || !versionId || configuration.harness === 'opencode') return null
  const change = (next: OperatorChatSettings) => {
    const base = configuration.harness === next.harness ? configuration : defaults.data?.defaults[next.harness]
    if (!base) return
    save.mutate({ workspaceId, agentId, commandId: `agent-settings-${crypto.randomUUID()}`,
      expectedRevision: entry.metadataRevision, expectedConfigurationVersionId: versionId,
      configuration: applyOperatorChatSettings(base, next) })
  }
  return <div className="agent-chat-settings">
    <OperatorComposerSettings value={operatorChatSettings(configuration, false)} hideThinking
      disabled={disabled || !allowed || save.isPending} onChange={change} />
    {save.isPending ? <small role="status">Saving Agent settings…</small> : null}
    {save.isError ? <small role="alert">{errorMessage(save.error, 'Agent settings could not be saved.')}</small> : null}
  </div>
}
