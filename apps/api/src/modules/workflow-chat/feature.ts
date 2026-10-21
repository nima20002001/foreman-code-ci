import type pg from 'pg'
import type { AgentSubject, ChatSendRequest, DeliveryTarget, WorkflowChatPost } from '@foreman-code/contracts'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ExecutionChatPort } from '../collaboration/ports.js'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import type { AgentChatService } from '../conversations/agentChat.js'
import type { PostgresAgentChatRepository } from '../conversations/agentChatRepository.js'
import type { ConversationFeatureBinder } from '../conversations/agentChat.js'
import type { OperatorChatService } from '../conversations/operatorChat.js'
import { DomainError } from '../errors.js'
import { ChatDeliveryRouter, type ChatTargetAuthority } from './delivery.js'
import { PostgresWorkflowChatRepository } from './repository.js'
import { WorkflowChatService } from './service.js'
import { WorkflowChatProjector, type CommittedReplySource } from './projection.js'
import { conversationReplySource, installConversationReplyProjection } from './conversationProjection.js'
import { LegacyChatDeliveryBridge, type LegacyTargetResolver } from './legacyBridge.js'
import type { ChannelScope, DeliveryQualification, WorkflowChatAuthority } from './model.js'
import { assertTargetScope } from './validation.js'
import { workflowChatNativeContext } from './nativeContext.js'

/** D implements this with the existing subject/credential and tool resolver, including disabled-tool/read-only checks. */
export interface SharedChatAccess {
  resolve(principal: ManagementPrincipal, action: ManagementAction, scope: ChannelScope | undefined, tx?: TransactionSql):
    Promise<{ principal: ManagementPrincipal; subject?: AgentSubject }>
  restore(principalId: string): Promise<ManagementPrincipal>
}
export interface WorkflowChatFeatureDependencies {
  pool: pg.Pool
  agent: AgentChatService
  agentRepository: PostgresAgentChatRepository
  operator: OperatorChatService
  access: SharedChatAccess
  execution: ExecutionChatPort
  /** Same owner lock/journal as ExecutionChatPort.deliver; includes exact full-envelope qualification, no native I/O. */
  qualifyExecutionLocked(tx: TransactionSql, principal: ManagementPrincipal, request: ChatSendRequest,
    channelContext?: string): Promise<DeliveryQualification>
  /** A's authoritative board store verifies every card is in this workflow or its containing workspace. */
  assertCardLinksLocked(tx: TransactionSql, principal: ManagementPrincipal, scope: ChannelScope, cardIds: readonly string[]): Promise<void>
  runReplies: CommittedReplySource
  targets: LegacyTargetResolver
  /** Exact retained execution/consultation read authority; does not require the target to remain runnable. */
  authorizeExecutionTarget(principal: ManagementPrincipal, target: Exclude<DeliveryTarget,
    { kind: 'agent_conversation' | 'operator_conversation' }>, action: 'read' | 'write' | 'cancel', tx?: TransactionSql): Promise<void>
  bindConversationScope: ConversationFeatureBinder
}

function author(principal: ManagementPrincipal, subject?: AgentSubject): WorkflowChatPost['author'] {
  if (subject) return { kind: 'agent', agent: subject.agent }
  if (principal.audience !== 'operator' && principal.audience !== 'user') {
    throw new DomainError('CHAT_AUTHOR_UNAVAILABLE', 'A scoped Agent subject is required for this caller.', 403)
  }
  return { kind: principal.audience, principalId: principal.id, displayName: principal.name }
}

/** C's complete composition export; D only registers routes/tools, shared dependencies, and lifecycle. */
export function createWorkflowChatFeature(dependencies: WorkflowChatFeatureDependencies) {
  const { pool, access } = dependencies
  const repository = new PostgresWorkflowChatRepository(pool)
  const changed = async (id: string) => { await service.receiptChanged(id) }
  const agent = dependencies.agent.createDeliveryOwner(repository.deliveries, changed)
  const operator = dependencies.operator.createDeliveryOwner(repository.deliveries, changed)
  dependencies.agent.installFeatureContextBinder(dependencies.bindConversationScope)
  const resolve = async (principal: ManagementPrincipal, scope: ChannelScope | undefined,
    action: 'read' | 'write' | 'cancel', tx?: TransactionSql, operatorTarget = false) => {
    const name: ManagementAction = operatorTarget ? `operator_chat:${action}` : `agent_chat:${action}`
    const actor = await access.resolve(principal, name, scope, tx)
    if (actor.principal.id !== principal.id) throw new DomainError('CHAT_PRINCIPAL_CHANGED', 'The authenticated chat actor changed.', 403)
    if (actor.subject && (!scope || actor.subject.agent.workspaceId !== scope.workspaceId || actor.subject.agent.workflowId !== scope.workflowId)) {
      throw new DomainError('CHAT_SCOPE_MISMATCH', 'The Agent credential belongs to another workflow.', 403)
    }
    return { ...actor, principal }
  }
  const qualify = (tx: TransactionSql, principal: ManagementPrincipal, request: ChatSendRequest, channelContext?: string) =>
    request.target.kind === 'agent_conversation' ? dependencies.agent.qualifyGroupDelivery(tx, principal, request, channelContext)
      : request.target.kind === 'operator_conversation' ? operator.qualifyLocked(tx, principal, request)
        : dependencies.qualifyExecutionLocked(tx, principal, request, channelContext)
  const scopeFor = (target: DeliveryTarget) => target.kind === 'operator_conversation' ? undefined : target.agent
  const authorizeTarget = async (principal: ManagementPrincipal, target: DeliveryTarget,
    action: 'read' | 'write' | 'cancel', tx?: TransactionSql) => {
    const actor = await resolve(principal, scopeFor(target), action, tx, target.kind === 'operator_conversation')
    if (target.kind === 'agent_conversation') await agent.hooks.authenticate(principal, target, action, tx)
    else if (target.kind === 'operator_conversation') await operator.hooks.authenticate(principal, target, action, tx)
    else await dependencies.authorizeExecutionTarget(principal, target, action, tx)
    return actor.principal
  }
  const targetAuthority: ChatTargetAuthority = {
    authenticate: (principal, target, action) => authorizeTarget(principal, target, action),
    authorizeLocked: async (tx, principal, target, action) => { await authorizeTarget(principal, target, action, tx) },
    qualifyLocked: async (tx, principal, request) => qualify(tx, principal, request, await workflowChatNativeContext(tx, request)),
    restorePrincipal: id => access.restore(id),
  }
  const authority: WorkflowChatAuthority = {
    authenticate: async (principal, scope, action) => {
      const actor = await resolve(principal, scope, action)
      return { ...actor, author: author(actor.principal, actor.subject) }
    },
    authorizeLocked: async (tx, principal, scope, action) => { await resolve(principal, scope, action, tx) },
    validateRecipientLocked: async (tx, principal, request, scope) => {
      assertTargetScope(request.target, scope)
      return qualify(tx, principal, request, await workflowChatNativeContext(tx, request,
        { ...(scope.replyToPostId ? { replyToPostId: scope.replyToPostId } : {}) }))
    },
    validateLinksLocked: async (tx, principal, request) => {
      if (request.replyToPostId && !(await tx.query(`select 1 from workflow_chat_posts p
        join workflow_chat_channels c on c.id=p.channel_id where p.id=$1 and c.workspace_id=$2 and c.workflow_id=$3`,
      [request.replyToPostId, request.workspaceId, request.workflowId])).rowCount) {
        throw new DomainError('CHAT_POST_NOT_FOUND', 'The referenced post belongs to another workflow or is unavailable.', 404)
      }
      if (request.cardIds.length) await dependencies.assertCardLinksLocked(tx, principal, request, request.cardIds)
    },
  }
  const router = new ChatDeliveryRouter(repository.deliveries, targetAuthority, dependencies.execution, agent, operator)
  const service = new WorkflowChatService(repository, authority, router)
  const projector = new WorkflowChatProjector(repository, (id, event) => service!.events.publish(id, event),
    conversationReplySource(repository.deliveries, dependencies.runReplies))
  installConversationReplyProjection(dependencies.agentRepository, repository.deliveries, projector)
  const bridge = new LegacyChatDeliveryBridge(router, dependencies.agent, dependencies.operator, dependencies.targets)
  dependencies.agent.installDeliveryBridge(bridge)
  dependencies.operator.installDeliveryBridge(bridge)
  return { repository, router, service, projector, bridge, targetAuthority,
    /** D invokes this within committed engine lifecycle/reply/consultation transactions. */
    enqueueCommitted: projector.enqueueCommitted.bind(projector),
    start: () => service!.startPendingDrain(projector) }
}
