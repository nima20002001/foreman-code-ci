import { readWorkflowNativeChat } from '../interactions/workflowChatNativeRead.js'
import { readWorkflowChatChanges } from './workflowChatChanges.js'
import { WorkflowChatNotifications } from './workflowChatNotifications.js'
import { PostgresChatDeliveryRepository } from '../workflow-chat/deliveryRepository.js'
import type { DeliveryQualification } from '../workflow-chat/model.js'
import { qualifyWorkflowChatSendLocked } from './workflowChatAdmission.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { canonicalJson, ChatControlReceiptSchema, ChatDeliveryReceiptSchema, ChatQueueCancelRequestSchema,
  ChatSendRequestSchema, ChatStopRequestSchema, sameAgentNode,
  type ChatQueueCancelRequest, type ChatSendRequest, type ChatStopRequest, type DeliveryTarget } from '@foreman-code/contracts'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import { withExclusiveGraphConnection } from '../run-graph/connection.js'
import type { ExecutionChatPort, Principal } from './ports.js'
import { admitWorkflowChatCancelLocked, admitWorkflowChatSendLocked, admitWorkflowChatStopLocked } from './workflowChatAdmission.js'
import { readWorkflowChatIdentity } from './workflowChatIdentity.js'
import { authorizeWorkflowChat, readWorkflowExecutionChat, withWorkflowChatRead } from './workflowChatRead.js'
import { resolveWorkflowChatTarget } from './workflowChatResolver.js'
import { asWorkflowChatTarget, commandReceipt, controlDigest, controlId, readControlCommand,
  replayControlCommand, workflowTargetRunId } from './workflowControlRecords.js'
import type { WorkflowChatLockedTarget, WorkflowChatTarget, WorkflowExecutionChatDependencies } from './workflowControlTypes.js'

/** HTTP, Group chat and MCP use this one durable Run-owned admission boundary. */
export class WorkflowExecutionChatService implements ExecutionChatPort {
  private readonly groupDeliveries: PostgresChatDeliveryRepository
  private readonly notifications: WorkflowChatNotifications
  constructor(private readonly pool: pg.Pool, private readonly dependencies: WorkflowExecutionChatDependencies) {
    this.groupDeliveries = new PostgresChatDeliveryRepository(pool)
    this.notifications = new WorkflowChatNotifications(pool)
  }
  private now() { return this.dependencies.now?.() ?? new Date().toISOString() }
  private commandId() { return this.dependencies.id?.() ?? randomUUID() }

  resolve(principal: Principal, input: unknown) {
    return withExclusiveGraphConnection(this.pool, connection => connection.transaction(async sql =>
      resolveWorkflowChatTarget(sql, await readLiveManagementPrincipal(sql, principal.id), input), true))
  }
  read(principal: Principal, request: { target: DeliveryTarget; cursor?: string | undefined; limit?: number | undefined }) {
    return readWorkflowExecutionChat(this.pool, this.dependencies.owner, principal, request)
  }
  changes(principal: Principal, target: WorkflowChatTarget, afterRevision?: string) {
    return readWorkflowChatChanges(this.pool, this.dependencies.owner, principal, target, afterRevision)
  }
  subscribe(target: WorkflowChatTarget, changed: () => void, failed: (error: Error) => void) {
    return this.notifications.subscribe({ target, changed, failed })
  }
  assertReadable(principal: Principal, target: WorkflowChatTarget) {
    return withWorkflowChatRead(this.pool, principal, target, 'agent_chat:read', sql => readWorkflowChatIdentity(sql, target))
  }
  async message(principal: Principal, target: WorkflowChatTarget, messageId: string) {
    return withWorkflowChatRead(this.pool, principal, target, 'agent_chat:read', async sql => {
      await readWorkflowChatIdentity(sql, target)
      const page = await readWorkflowNativeChat(sql, target, { messageId, limit: 1, bindings: [] })
      const message = page.messages.find(item => item.id === messageId)
      if (!message) throw new DomainError('CHAT_MESSAGE_NOT_FOUND', 'The selected native message is unavailable.', 404)
      return message
    })
  }
  async qualify(principal: Principal, request: ChatSendRequest, channelContext?: string): Promise<DeliveryQualification> {
    const target = asWorkflowChatTarget(request.target)
    return this.dependencies.owner.transaction(target, async context => {
      authorizeWorkflowChat(await readLiveManagementPrincipal(context.sql, principal.id), target, 'agent_chat:write')
      await readWorkflowChatIdentity(context.sql, target)
      const prepared = await qualifyWorkflowChatSendLocked(context, request, {
        id: controlId('chat-delivery', principal.id, request.commandId ?? this.commandId()), principalId: principal.id,
        ...(channelContext ? { channelContext } : {}),
      }, this.dependencies.owner)
      return { appliedIntent: prepared.appliedIntent, ownerBinding: {
        agentIdentity: context.agent, configurationVersionId: context.agent.configurationVersionId,
        ...(context.native ? { nativeSessionId: context.native.nativeSessionId,
          ownerRequestId: context.native.ownerRequestId,
          ...(context.native.nativeTurnId ? { nativeTurnId: context.native.nativeTurnId } : {}),
          ...(context.native.inputMessageId ? { inputMessageId: context.native.inputMessageId } : {}) } : {}),
      } }
    })
  }
  async deliver(principal: Principal, raw: ChatSendRequest) {
    const parsed = ChatSendRequestSchema.parse(raw), request = { ...parsed, commandId: parsed.commandId ?? this.commandId() }
    const target = asWorkflowChatTarget(request.target), digest = controlDigest({ kind: 'delivery', request })
    const replay = await this.replay(principal, target, request.commandId, digest, 'agent_chat:write')
    if (replay) return ChatDeliveryReceiptSchema.parse(replay)
    await this.dependencies.assertAttachments(principal, request)
    const prepared = await this.groupDeliveries.find(principal.id, request.commandId)
    const id = prepared?.receipt.id ?? controlId('chat-delivery', principal.id, request.commandId)
    const admitted = await this.dependencies.owner.transaction(target, async context => {
      await this.checkContext(context, principal, target, 'agent_chat:write', request.commandId)
      const stored = await replayControlCommand(context.sql, principal.id, request.commandId, digest)
      if (stored) return { receipt: ChatDeliveryReceiptSchema.parse(stored.receipt), replayed: true }
      if (prepared) {
        await this.groupDeliveries.adoptPreparedLocked(context.sql, principal.id, request, async command => {
          if (command.receipt.appliedIntent !== 'next_turn') {
            const retained = command.ownerBinding
            const native = context.native
            if (!native || retained.nativeSessionId !== native.nativeSessionId
              || retained.ownerRequestId !== native.ownerRequestId || retained.nativeTurnId !== native.nativeTurnId
              || retained.inputMessageId !== native.inputMessageId) {
              throw new DomainError('CHAT_TARGET_CHANGED', 'The native target changed after the Group message was accepted.', 409)
            }
          }
          const qualified = await qualifyWorkflowChatSendLocked(context, request,
            { id, principalId: principal.id }, this.dependencies.owner)
          if (qualified.appliedIntent !== command.receipt.appliedIntent) throw new DomainError(
            'CHAT_TARGET_CHANGED', 'The native target changed after the Group message was accepted.', 409)
          return true
        })
      }
      const receipt = await admitWorkflowChatSendLocked(context, request, { id, commandId: request.commandId,
        principalId: principal.id, now: prepared?.receipt.createdAt ?? this.now() }, this.dependencies.owner)
      return { receipt, replayed: false }
    })
    if (!admitted.replayed) await this.dispatch(target, id)
    return withWorkflowChatRead(this.pool, principal, target, 'agent_chat:read', async sql =>
      ChatDeliveryReceiptSchema.parse((await readControlCommand(sql, id))?.receipt ?? admitted.receipt))
  }
  stop(principal: Principal, raw: ChatStopRequest) {
    const parsed = ChatStopRequestSchema.parse(raw)
    return this.control(principal, 'stop', { ...parsed, commandId: parsed.commandId ?? this.commandId() })
  }
  cancel(principal: Principal, raw: ChatQueueCancelRequest) {
    const parsed = ChatQueueCancelRequestSchema.parse(raw)
    return this.control(principal, 'cancel', { ...parsed, commandId: parsed.commandId ?? this.commandId() })
  }

  private async control(principal: Principal, kind: 'stop' | 'cancel', request: (ChatStopRequest | ChatQueueCancelRequest) & { commandId: string }) {
    const target = asWorkflowChatTarget(request.target), digest = controlDigest({ kind, request })
    const replay = await this.replay(principal, target, request.commandId, digest, 'agent_chat:cancel')
    if (replay) return { ...ChatControlReceiptSchema.parse(replay), replayed: true }
    const id = controlId(`chat-${kind}`, principal.id, request.commandId)
    const admitted = await this.dependencies.owner.transaction(target, async context => {
      await this.checkContext(context, principal, target, 'agent_chat:cancel', request.commandId)
      const stored = await replayControlCommand(context.sql, principal.id, request.commandId, digest)
      if (stored) return { ...ChatControlReceiptSchema.parse(stored.receipt), replayed: true }
      const identity = { id, commandId: request.commandId, principalId: principal.id, now: this.now() }
      return kind === 'stop' ? admitWorkflowChatStopLocked(context, ChatStopRequestSchema.parse(request), identity)
        : admitWorkflowChatCancelLocked(context, ChatQueueCancelRequestSchema.parse(request), identity)
    })
    if (!admitted.replayed && kind === 'stop' && admitted.state === 'settling') await this.dispatch(target, id)
    return withWorkflowChatRead(this.pool, principal, target, 'agent_chat:read', async sql => {
      const receipt = (await readControlCommand(sql, id))?.receipt ?? admitted
      return { ...ChatControlReceiptSchema.parse(receipt), replayed: admitted.replayed }
    })
  }
  private replay(principal: Principal, target: WorkflowChatTarget, commandId: string, digest: string,
    action: 'agent_chat:write' | 'agent_chat:cancel') {
    return withWorkflowChatRead(this.pool, principal, target, action, async sql => {
      const row = await replayControlCommand(sql, principal.id, commandId, digest)
      return row ? commandReceipt(row) : undefined
    })
  }
  private async checkContext(context: WorkflowChatLockedTarget, principal: Principal, target: WorkflowChatTarget,
    action: 'agent_chat:write' | 'agent_chat:cancel', commandId: string) {
    authorizeWorkflowChat(await readLiveManagementPrincipal(context.sql, principal.id), target, action)
    if (canonicalJson(context.target) !== canonicalJson(target) || context.run.id !== workflowTargetRunId(target)
      || context.run.workspaceId !== target.agent.workspaceId || context.run.workflowId !== target.agent.workflowId
      || context.version.id !== context.run.workflowVersionId || !sameAgentNode(context.agent, target.agent)) {
      throw new DomainError('CHAT_TARGET_MISMATCH', 'The existing owner did not resolve the exact selected target.', 409)
    }
    await readWorkflowChatIdentity(context.sql, target)
    // Serializes command identity across different exact targets; this is not a Run owner.
    await context.sql.query('select pg_advisory_xact_lock($1,hashtext($2))', [810706, `${principal.id}:${commandId}`])
  }
  private async dispatch(target: WorkflowChatTarget, commandId: string): Promise<void> {
    try { await this.dependencies.owner.dispatch(target, commandId) }
    catch (error) {
      // Admission is durable. The existing owner reconciles unknown/submitting work;
      // replay reads its receipt and must never issue another native command here.
      componentLogger('harness').warn({ err: error, runId: workflowTargetRunId(target), commandId }, 'Run chat command awaits native reconciliation')
    }
  }
}
