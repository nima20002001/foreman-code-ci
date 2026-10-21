import { AgentIdentitySchema, type AgentIdentity } from '@foreman-code/contracts'
import { CurrentWorkflowReadResultSchema, RunVersionDetailSchema } from '@foreman-code/contracts/wave25'
import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'
import { agentChatApi } from '../../shared/api/agentChat'
import { selectedRunChatApi } from '../conversations/agentChat/selectedRunChatClient'
import type { RecipientTargetOption, WorkflowTargetResolver } from '../workflow-chat/RecipientTargetPicker'
import { readPinnedAgentVersion } from './runDetailsClient'

export async function readGroupParticipants(workspaceId: string, workflowId: string, runId: string | undefined,
  options: RequestOptions): Promise<AgentIdentity[]> {
  const workspace = encodeURIComponent(workspaceId)
  const version = runId
    ? (await apiClient.request(`/api/management/workspaces/${workspace}/runs/${encodeURIComponent(runId)}/version`,
      RunVersionDetailSchema, options)).version
    : (await apiClient.request(`/api/management/workspaces/${workspace}/workflows/${encodeURIComponent(workflowId)}/definition`,
      CurrentWorkflowReadResultSchema, options)).version
  if (version.workspaceId !== workspaceId || version.workflowId !== workflowId) {
    throw new ApiError({ code: 'CHAT_SCOPE_MISMATCH', message: 'The saved participants belong to another workflow.' }, 409)
  }
  const configurations = new Map(await Promise.all(Object.entries(version.agentConfigurationVersionIds).map(async ([agentId, id]) =>
    [agentId, await readPinnedAgentVersion(workspaceId, agentId, id, options)] as const)))
  return version.definition.nodes.flatMap(node => {
    if (node.kind === 'job') return []
    const configuration = configurations.get(node.agentId)
    if (!configuration) throw new ApiError({ code: 'CHAT_PARTICIPANT_UNAVAILABLE', message: 'A saved Agent configuration is unavailable.' }, 409)
    return [AgentIdentitySchema.parse({ workspaceId, workflowId, workflowNodeId: node.id, agentId: node.agentId,
      displayName: node.name ?? node.label ?? node.agentId,
      productRole: configuration.productRole ?? 'coder', configurationVersionId: configuration.id })]
  })
}

function option(state: AgentChatState, label: string): RecipientTargetOption[] {
  if (!state.deliveryTarget) {
    throw new ApiError({ code: 'CHAT_TARGET_UNAVAILABLE', message: state.availability.message ?? 'This Agent has no available chat target.' }, 409)
  }
  return [{ target: state.deliveryTarget, label, deliveryTargetState: state.deliveryTargetState,
    presentation: { state: state.activeTurn ? 'active' : 'idle',
      nativeTurnId: state.activeTurn?.nativeTurnId,
      capabilities: { steer: state.capabilities.steer === 'native_expected_turn' ? 'native_expected_turn' : 'unavailable',
        queue: state.capabilities.queueNextTurn, interruptAndSend: state.capabilities.interruptAndSend },
      unavailableReason: state.availability.canSend ? undefined : state.availability.message } }]
}

export function groupTargetResolver(runId?: string): WorkflowTargetResolver {
  return async (agent, input) => {
    let selectedRun = input.recovery === 'outside_run' ? undefined : runId
    let executionId: string | undefined
    if (input.recovery === 'historical_follow_up' && input.sourceTarget?.kind === 'workflow_execution') {
      selectedRun = input.sourceTarget.execution.runId
      executionId = input.sourceTarget.execution.executionId
    }
    const context = { workspaceId: agent.workspaceId, workflowId: agent.workflowId,
      workflowNodeId: agent.workflowNodeId, agentId: agent.agentId }
    if (!selectedRun) return option(await agentChatApi.read(context, { signal: input.signal }), 'Outside run')
    const selection = { ...context, runId: selectedRun, ...(executionId ? { executionId } : {}) }
    const result = await selectedRunChatApi.read(selection, { signal: input.signal })
    if (result.kind === 'selected') return option(result.state, `Run ${selectedRun}`)
    if (result.kind === 'unavailable') throw new ApiError({ code: 'CHAT_TARGET_UNAVAILABLE', message: 'Chat is unavailable for this selected Run node.' }, 409)
    const choices = await Promise.all(result.executions.map(async execution => {
      const exact = await selectedRunChatApi.read({ ...selection, executionId: execution.executionId }, { signal: input.signal })
      return exact.kind === 'selected' ? option(exact.state, `Attempt ${execution.attempt} · ${execution.executionId}`) : []
    }))
    return choices.flat()
  }
}
