import { AgentChatQuerySchema, AgentChatControlsStateSchema, AgentChatControlsUpdateRequestSchema } from '@foreman-code/contracts/agent-chat'
import { z } from 'zod'
import { SessionControlRequestSchema, SessionControlStateSchema } from '@foreman-code/contracts'
import type { OperatorRequestContext } from '../types.js'
import { defineOperatorTool } from '../definition.js'
import { isAuthorized, requireAuthorization } from '../../../modules/access/policy.js'
import { DomainError } from '../../../modules/errors.js'

const id = z.string().min(1)
export const sessionControlTools = (['operator', 'agent'] as const).flatMap((role) => {
  const target = z.object({ conversationId: id.optional(), context: AgentChatQuerySchema.optional(), executionId: id.optional(), workspaceId: role === 'agent' ? id : z.never().optional() }).strict().superRefine((value, issue) => {
    if (role === 'operator' && (!value.conversationId || value.context)) issue.addIssue({ code: 'custom', message: 'Operator controls require conversationId.' })
    if (role === 'agent' && (!!value.conversationId === !!value.context)) issue.addIssue({ code: 'custom', message: 'Supply one conversationId or node context.' })
  })
  const read = async (context: OperatorRequestContext, conversationId: string | undefined, workspaceId?: string, selector?: import('@foreman-code/contracts/agent-chat').AgentChatQuery, executionId?: string) => {
    if (role === 'operator') return context.services.operatorChat!.readSessionControls(id.parse(conversationId), context.principal)
    const workspace = id.parse(workspaceId)
    const state = !conversationId && selector
      ? await context.services.agentChat!.readContextControls(context.principal, { workspaceId: workspace, ...selector }, executionId)
      : await context.services.agentChat!.readSessionControls(context.principal, workspace, id.parse(conversationId))
    if (!context.services.agents || !isAuthorized(context.principal, 'agents:read', { workspaceId: workspace })) return state
    const target = selector ?? await context.services.agentChat!.configurationContext(context.principal, workspace, id.parse(conversationId))
    const saved = await context.services.agents.get(context.principal, workspace, target.agentId)
    const harness = saved.agent.harnessConfiguration
    if (!harness || harness.harness === 'opencode' || !saved.agent.configurationVersionId) return state
    return { ...state, configuration: { versionId: saved.agent.configurationVersionId,
      metadataRevision: saved.metadataRevision, harness } }
  }
  const enabled = role === 'operator'
    ? (s: OperatorRequestContext['services']) => !!s.operatorChat
    : (s: OperatorRequestContext['services']) => !!s.agentChat
  return [
    defineOperatorTool({
      name: `${role}_chat_controls_get`,
      requires: role === 'operator' ? [['operator_chat:read', 'global']]
        : [['agent_chat:read', 'resource'], ['agent_chat:read', 'resource']],
      enabled,
      description: 'Read native session controls, capabilities, context and desired/applied settings for this conversation. Before the first turn, capabilities.modelCapacity is the selected model’s catalog context window when advertised; context and nativeSessionId remain null. With agents:read, Agent controls also return configuration: the saved harness/model/effort/account, versionId and metadataRevision used by configuration updates. Unloaded sessions return saved controls with nativeStatus: resume-required and stale context; a subsequent message or control resumes the native session. Agent chat requires workspaceId and either conversationId or context; fresh context may have no conversation. Use sourceTranscript.executionId from agent_chat_read to pin historical controls. Without executionId, context uses the same Board execution choice as agent_chat_read query. Starting or running executions return pending controls with busyReason; reads do not create a chat. No model turn is sent. Requires the matching chat read grant.',
      inputSchema: target, outputSchema: role === 'agent' ? AgentChatControlsStateSchema : SessionControlStateSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: (context, { conversationId, workspaceId, context: selector, executionId }) =>
        read(context, conversationId, workspaceId, selector, executionId),
    }),
    defineOperatorTool({
      name: `${role}_chat_controls_update`,
      requires: role === 'operator' ? [['operator_chat:write', 'global'], ['operator_chat:read', 'global']]
        : [['agent_chat:write', 'resource'], ['agent_chat:read', 'resource']],
      enabled,
      permissionDetail: 'Requires matching chat write/read grants. Agent configuration requests additionally use agent_update authority: workspace agents:update, agents:read on the workspace or a referencing workflow, graph:read/edit on every referencing workflow, and any harness/skill permissions required by that saved configuration. Mode/context preferences keep their existing chat grants; save-default additionally requires scoped agents:update or Operator settings:update.',
      description: 'Compact the existing idle native session or change subsequent-turn mode/context preferences. Agent request kind configuration saves the Agent harness/model/effort/account through agent_update; use configuration.metadataRevision and configuration.versionId from controls_get as expectedRevision and expectedConfigurationVersionId. The next turn uses the saved settings in the same chat, resuming the native session or carrying conversation history into a fresh session when the harness or account changes. This additionally requires agents:update, agents:read and graph read/edit access to every referencing workflow, with the same validation, conflicts and audit records as agent_update. Other requests use expectedRevision from controls_get. Requires matching chat write and read grants; reuse requestId and identical input after response loss. Read to recover uncertain compaction; never issue a second identity. A running Operator cannot compact itself. Mode changes do not send a task or broaden permissions. Saving future defaults additionally requires settings:update for Operator or scoped agents:update for agent chat.',
      inputSchema: target.extend({ request: role === 'agent' ? AgentChatControlsUpdateRequestSchema : SessionControlRequestSchema }),
      outputSchema: role === 'agent' ? AgentChatControlsStateSchema : SessionControlStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (context, { conversationId, workspaceId, request, context: selector, executionId }) => {
        if (request.kind === 'configuration') {
          if (role !== 'agent' || !context.services.extensions?.agents) {
            throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'Agent configuration editing is unavailable.', 503)
          }
          const workspace = id.parse(workspaceId)
          await read(context, conversationId, workspace, selector, executionId)
          const chat = selector ?? await context.services.agentChat!.configurationContext(context.principal, workspace, id.parse(conversationId))
          requireAuthorization(context.principal, 'agent_chat:write', { workspaceId: workspace,
            workflowId: chat.workflowId, ...(chat.runId ? { runId: chat.runId } : {}) })
          await context.services.extensions.agents.update(context.principal,
            { workspaceId: workspace, agentId: chat.agentId, commandId: request.requestId,
              expectedRevision: request.expectedRevision,
              expectedConfigurationVersionId: request.expectedConfigurationVersionId,
              configuration: request.configuration }, 'mcp')
          return read(context, conversationId, workspace, selector, executionId)
        }
        return role === 'operator'
        ? context.services.operatorChat!.changeSessionControls(id.parse(conversationId), request, context.principal, 'mcp')
        : !conversationId && selector ? context.services.agentChat!.changeContextControls(context.principal, { workspaceId: id.parse(workspaceId), ...selector }, request, 'mcp', executionId)
        : context.services.agentChat!.changeSessionControls(context.principal, id.parse(workspaceId), id.parse(conversationId), request, 'mcp')
      },
    }),
  ]
})
