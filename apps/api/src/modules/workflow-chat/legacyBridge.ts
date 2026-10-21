import { omitProperties } from '../../shared/omitProperties.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { ChatQueueCancelRequest, ChatStopRequest, DeliveryTarget, SendOperatorMessageRequest } from '@foreman-code/contracts'
import type { AgentChatQuery, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { SelectedRunChatExecution } from '@foreman-code/contracts/selected-run-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { AgentChatService } from '../conversations/agentChat.js'
import type { OperatorChatService } from '../conversations/operatorChat.js'
import { DomainError } from '../errors.js'
import type { ChatDeliveryRouter } from './delivery.js'
import type { DeliveryInputRead } from './retainedInputs.js'
import { componentLogger } from '../diagnostics/logger.js'

type LegacyAgentTarget = DeliveryTarget | { kind: 'historical_execution'; selection: SelectedRunChatExecution }
export interface LegacyTargetResolver {
  /** D's existing selected-node resolver supplies exact active/queued/consultation targets without creating a conversation. */
  resolve(principal: ManagementPrincipal, workspaceId: string, query: AgentChatQuery): Promise<LegacyAgentTarget>
}
const changed = () => new DomainError('CHAT_TARGET_CHANGED', 'The selected chat target changed; read it again before sending.', 409)

/** A durable receipt survives an unavailable current snapshot; authorization denial still fails closed. */
async function retainedSnapshot<T extends object>(read: () => Promise<T>): Promise<T | Record<string, never>> {
  try { return await read() }
  catch (error) {
    if (error instanceof DomainError && [401, 403].includes(error.status)) throw error
    componentLogger('engine').warn({ err: error }, 'The recorded chat command has no available current snapshot')
    return {}
  }
}

/** HTTP and MCP share this adapter; no native turn is invented to fill a legacy response. */
export class LegacyChatDeliveryBridge {
  constructor(readonly router: ChatDeliveryRouter, private readonly agent: AgentChatService,
    private readonly operator: OperatorChatService, private readonly targets?: LegacyTargetResolver) {}

  async sendAgent(principal: ManagementPrincipal, workspaceId: string, input: SendAgentChatMessageRequest) {
    await this.agent.assertContextReadable(principal, workspaceId, input.context)
    const prior = await this.router.repository.find(principal.id, input.requestId)
    if (!prior) {
      const legacy = await this.agent.replayLegacyDelivery(principal, workspaceId, input)
      if (legacy) return legacy
    }
    const target = prior?.request.target ?? await this.agentTarget(principal, workspaceId, input.context)
    if (target.kind === 'historical_execution') {
      return this.agent.sendSelectedRun(principal, { selection: target.selection, message: omitProperties(input, ['context']) })
    }
    if (target.kind === 'operator_conversation' || target.agent.workspaceId !== workspaceId
      || target.agent.workflowId !== input.context.workflowId || target.agent.workflowNodeId !== input.context.workflowNodeId
      || target.agent.agentId !== input.context.agentId) throw changed()
    if (!prior && target.kind === 'agent_conversation' && input.expectedConversationId !== null
      && input.expectedConversationId !== target.conversationId) throw changed()
    if (!prior && target.kind === 'agent_conversation' && input.expectedConversationId === null
      && await this.agent.hasDeliveryConversation(target.conversationId)) throw changed()
    const effective = omitProperties(input, ['requestId'])
    const receipt = await this.router.send(principal, { commandId: input.requestId, target, intent: input.intent,
      content: input.content, attachments: input.attachments, ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      ...(input.expectedNativeTurnId ? { expectedNativeTurnId: input.expectedNativeTurnId } : {}) }, {
      inputHash: commandInputHash(effective), beforeQualifyLocked: tx => this.agent.assertLegacyTargetLocked(tx, target,
        input.context, input.expectedConversationId) })
    if (target.kind !== 'agent_conversation') {
      // Exact Run-owned readback has its own native leaf/provenance; never manufacture a standalone turn.
      return { ...await retainedSnapshot(async () => ({ state: await this.router.read(principal, { target }) })), receipt, replayed: Boolean(prior) }
    }
    return { ...await retainedSnapshot(() => this.agent.deliveryEnvelope(principal, workspaceId, target.conversationId, input.requestId)), receipt,
      replayed: Boolean(prior) }
  }

  async sendOperator(principal: ManagementPrincipal, conversationId: string, input: SendOperatorMessageRequest) {
    await this.operator.assertDeliveryReadable(principal)
    const prior = await this.router.repository.find(principal.id, input.requestId)
    if (!prior) {
      const legacy = await this.operator.replayLegacyDelivery(principal, conversationId, input)
      if (legacy) return legacy
    }
    const target: DeliveryTarget = { kind: 'operator_conversation', conversationId }
    const effective = omitProperties(input, ['requestId', 'recovery'])
    if (!prior && input.recovery === 'receipt') throw new DomainError('OPERATOR_RECEIPT_NOT_FOUND', 'No receipt is visible for this command.', 404)
    const receipt = await this.router.send(principal, { commandId: input.requestId, target, intent: input.intent ?? 'next_turn',
      content: input.content, ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      ...(input.expectedNativeTurnId ? { expectedNativeTurnId: input.expectedNativeTurnId } : {}) }, {
      inputHash: commandInputHash(effective), qualifyLocked: (tx, caller, request) =>
        this.operator.qualifyLegacyDelivery(tx, caller, request, input) })
    return { ...await retainedSnapshot(async () => ({ state: await this.operator.get(conversationId, principal) })), receipt, replayed: Boolean(prior) }
  }

  async stopAgent(principal: ManagementPrincipal, workspaceId: string, conversationId: string,
    input: { requestId: string; scope: ChatStopRequest['scope']; expectedNativeTurnId?: string | undefined }) {
    const target = await this.conversationTarget(principal, workspaceId, conversationId)
    const receipt = await this.router.stop(principal, { commandId: input.requestId, target, scope: input.scope,
      ...(input.expectedNativeTurnId ? { expectedNativeTurnId: input.expectedNativeTurnId } : {}) })
    return { state: await this.agent.readConversation(principal, workspaceId, conversationId), receipt }
  }

  async cancelAgent(principal: ManagementPrincipal, workspaceId: string, conversationId: string,
    input: Pick<ChatQueueCancelRequest, 'commandId' | 'selection'>) {
    const target = await this.conversationTarget(principal, workspaceId, conversationId)
    const receipt = await this.router.cancel(principal, { ...input, target })
    return { state: await this.agent.readConversation(principal, workspaceId, conversationId), receipt }
  }

  async cancelOperator(principal: ManagementPrincipal, conversationId: string,
    input: Pick<ChatQueueCancelRequest, 'commandId' | 'selection'>) {
    const receipt = await this.router.cancel(principal, { ...input, target: { kind: 'operator_conversation', conversationId } })
    return { state: await this.operator.get(conversationId, principal), receipt }
  }

  async readAgentInputs(principal: ManagementPrincipal, workspaceId: string,
    input: { query?: AgentChatQuery | undefined; conversationId?: string | undefined; target?: DeliveryTarget | undefined }, deliveryInputs: DeliveryInputRead) {
    let target = input.target ?? (input.conversationId
      ? await this.conversationTarget(principal, workspaceId, input.conversationId)
      : input.query ? await this.agentTarget(principal, workspaceId, input.query) : undefined)
    if (target?.kind === 'historical_execution') {
      const selected = await this.agent.readSelectedRun(principal, { selection: target.selection })
      if (selected.kind !== 'selected' || !selected.key) throw new DomainError('CHAT_TARGET_UNAVAILABLE',
        'No follow-up conversation exists for this execution.', 409)
      target = { kind: 'agent_conversation', conversationId: selected.key.conversationId, agent: {
        workspaceId, workflowId: selected.key.workflowId, workflowNodeId: selected.key.workflowNodeId,
        agentId: selected.key.agentId,
      } }
    }
    if (!target || target.kind === 'operator_conversation' || target.agent.workspaceId !== workspaceId) throw changed()
    const result = await this.router.read(principal, { target, deliveryInputs })
    if (!('deliveryInputs' in result)) throw new Error('Retained input readback is unavailable.')
    return result.deliveryInputs
  }

  private async agentTarget(principal: ManagementPrincipal, workspaceId: string, query: AgentChatQuery): Promise<LegacyAgentTarget> {
    if (this.targets) return this.targets.resolve(principal, workspaceId, query)
    if (query.runId) throw new DomainError('CHAT_TARGET_RESOLVER_UNAVAILABLE', 'Exact Run targeting requires the shared selected-node resolver.', 503)
    const state = await this.agent.read(principal, workspaceId, query)
    if (!state.deliveryTarget) throw changed()
    return state.deliveryTarget
  }

  private async conversationTarget(principal: ManagementPrincipal, workspaceId: string, conversationId: string): Promise<DeliveryTarget> {
    return this.agent.retainedConversationTarget(principal, workspaceId, conversationId)
  }
}
