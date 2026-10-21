import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type pg from 'pg'
import { type ChatControlReceipt, type ChatDeliveryReceipt, type ChatSendRequest, type ChatStopRequest,
  type ChatQueueCancelRequest, type DeliveryTarget } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { withTransaction, type TransactionSql } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import type { ConversationDeliveryPort } from '../workflow-chat/delivery.js'
import type { PostgresChatDeliveryRepository } from '../workflow-chat/deliveryRepository.js'
import { PostgresChatControlRepository, type ControlOwnerBinding, type RetainedControlRequest } from '../workflow-chat/controlRepository.js'
import type { ChatTargetRead, DeliveryQualification, StoredDelivery } from '../workflow-chat/model.js'
import { assertChatCommandKind } from '../workflow-chat/commandIdentity.js'

export type ConversationTarget = Extract<DeliveryTarget, { kind: 'agent_conversation' | 'operator_conversation' }>
export interface ConversationOwnerState {
  id: string; activeRequestId: string | null; nativeTurnId: string | null; nativeSessionId: string | null
}
/** Hooks belong to the existing conversation service. They never create a second native manager or observer. */
export interface ConversationDeliveryHooks {
  authenticate(principal: ManagementPrincipal, target: ConversationTarget, action: 'read' | 'write' | 'cancel', sql?: TransactionSql): Promise<void>
  lock(tx: TransactionSql, principal: ManagementPrincipal, target: ConversationTarget): Promise<ConversationOwnerState>
  qualifyLocked(tx: TransactionSql, principal: ManagementPrincipal, input: ChatSendRequest): Promise<DeliveryQualification>
  journalLocked(tx: pg.PoolClient, principal: ManagementPrincipal, command: StoredDelivery): Promise<void>
  dispatch(principal: ManagementPrincipal, target: ConversationTarget, commandId: string): Promise<void>
  dispatchStop(principal: ManagementPrincipal, target: ConversationTarget, owner: ControlOwnerBinding): Promise<void>
  read(principal: ManagementPrincipal, target: ConversationTarget): Promise<ChatTargetRead>
  /** Reads persisted owner evidence only. */
  progress(command: StoredDelivery, tx: TransactionSql): Promise<Partial<Pick<ChatDeliveryReceipt, 'state' | 'nativeTurnId' | 'errorCode'>>>
  changed?(receiptId: string): Promise<void>
  conversationChanged?(target: ConversationTarget): Promise<void>
}

function conversationTarget(target: DeliveryTarget): ConversationTarget {
  if (target.kind !== 'agent_conversation' && target.kind !== 'operator_conversation') {
    throw new DomainError('CHAT_TARGET_INVALID', 'This native owner accepts only its exact conversation.', 422)
  }
  return target
}

export class ConversationDeliveryOwner implements ConversationDeliveryPort {
  readonly controls: PostgresChatControlRepository
  constructor(private readonly pool: pg.Pool, readonly receipts: PostgresChatDeliveryRepository,
    readonly hooks: ConversationDeliveryHooks) { this.controls = new PostgresChatControlRepository(pool) }

  async qualifyLocked(tx: TransactionSql, principal: ManagementPrincipal, input: ChatSendRequest,
    qualify = this.hooks.qualifyLocked) {
    const qualified = await qualify(tx, principal, input)
    const target = conversationTarget(input.target)
    const count = (await tx.query<{ count: string }>(`select count(*)::text as count from (
      select command_id as id from chat_delivery_commands where target_hash=$1 and receipt->>'state' in ('queued','submitting','accepted','unknown')
      union select request_id from operator_conversation_turns where conversation_id=$2
        and delivery in ('queued','submitting','accepted','unknown')) unfinished`, [commandInputHash(target), target.conversationId])).rows[0]
    if (Number(count?.count ?? 0) >= 100) throw new DomainError('CHAT_QUEUE_FULL', 'This conversation has 100 unfinished messages.', 409)
    return qualified
  }

  async deliver(principal: ManagementPrincipal, input: ChatSendRequest): Promise<ChatDeliveryReceipt> {
    if (!input.commandId) throw new DomainError('CHAT_COMMAND_REQUIRED', 'Owner admission requires a retained command.', 422)
    const request = { ...input, commandId: input.commandId }, target = conversationTarget(input.target)
    await this.hooks.authenticate(principal, target, 'read')
    const adopted = await withTransaction(this.pool, async tx => {
      await this.hooks.lock(tx, principal, target)
      return this.receipts.adoptPreparedLocked(tx, principal.id, request, async command => {
        await this.hooks.authenticate(principal, target, 'write', tx)
        await this.hooks.journalLocked(tx, principal, command)
      })
    }, { conflictRetries: 2 })
    if (adopted.adopted) {
      // The owner journal and prepared→owner_admitted CAS have committed together.
      // Any interruption here is recovered by this service's existing durable queue.
      await this.hooks.dispatch(principal, target, request.commandId)
    }
    return this.refresh(adopted.command)
  }

  async refresh(command: StoredDelivery): Promise<ChatDeliveryReceipt> {
    if (command.ownerAdmission !== 'owner_admitted') return command.receipt
    const result = await withTransaction(this.pool, async tx => {
      const target = conversationTarget(command.request.target)
      await tx.query('select id from operator_conversations where id=$1 for update', [target.conversationId])
      await tx.query('select id from chat_delivery_commands where id=$1 for update', [command.receipt.id])
      const current = await this.receipts.byReceipt(command.receipt.id, tx)
      if (!current) throw new DomainError('CHAT_RECEIPT_NOT_FOUND', 'The owner receipt is unavailable.', 404)
      if (['completed', 'failed', 'canceled'].includes(current.receipt.state)) return { receipt: current.receipt, changed: false }
      const evidence = await this.hooks.progress(current, tx)
      const next = { ...current.receipt, ...evidence, updatedAt: new Date().toISOString() }
      if (evidence.errorCode === undefined && ['accepted', 'completed', 'canceled'].includes(evidence.state ?? '')) delete next.errorCode
      if (Object.entries(evidence).every(([key, value]) => current.receipt[key as keyof ChatDeliveryReceipt] === value)
        && next.errorCode === current.receipt.errorCode) return { receipt: current.receipt, changed: false }
      await this.receipts.updateLocked(tx, next)
      return { receipt: next, changed: true }
    }, { conflictRetries: 2 })
    if (result.changed) await this.hooks.changed?.(result.receipt.id)
    return result.receipt
  }

  async read(principal: ManagementPrincipal, input: { target: DeliveryTarget }): Promise<ChatTargetRead> {
    const target = conversationTarget(input.target)
    await this.hooks.authenticate(principal, target, 'read')
    const commands = await this.receipts.forTarget(target, undefined, 100)
    const receipts = await Promise.all(commands.map(command => this.refresh(command)))
    const state = await this.hooks.read(principal, target)
    return { ...state, receipts }
  }

  stop(principal: ManagementPrincipal, input: ChatStopRequest): Promise<ChatControlReceipt> {
    return this.control(principal, { ...input, commandId: input.commandId ?? randomUUID() })
  }
  cancel(principal: ManagementPrincipal, input: ChatQueueCancelRequest): Promise<ChatControlReceipt> {
    return this.control(principal, { ...input, commandId: input.commandId ?? randomUUID() })
  }

  private async control(principal: ManagementPrincipal, input: RetainedControlRequest): Promise<ChatControlReceipt> {
    const target = conversationTarget(input.target)
    await this.hooks.authenticate(principal, target, 'read')
    const prior = await this.controls.find(principal.id, input.commandId)
    if (prior) return this.controls.replay(prior, input)
    if (await this.receipts.find(principal.id, input.commandId)) throw new DomainError('CHAT_COMMAND_CONFLICT', 'This command already identifies a message delivery.', 409)
    const result = await withTransaction(this.pool, async tx => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`chat-command:${principal.id}:${input.commandId}`])
      await this.hooks.authenticate(principal, target, 'read', tx)
      const found = await this.controls.find(principal.id, input.commandId, tx)
      if (found) return { receipt: this.controls.replay(found, input), replayed: true, owner: found.ownerBinding, changed: false }
      await assertChatCommandKind(tx, principal.id, input.commandId, 'control')
      if (await this.receipts.find(principal.id, input.commandId, tx)) throw new DomainError('CHAT_COMMAND_CONFLICT', 'This command already identifies a message delivery.', 409)
      const current = await this.hooks.lock(tx, principal, target)
      await this.hooks.authenticate(principal, target, 'cancel', tx)
      const stopping = 'scope' in input
      if (stopping && input.expectedNativeTurnId && input.expectedNativeTurnId !== current.nativeTurnId) {
        throw new DomainError('CHAT_TARGET_CHANGED', 'The addressed native turn changed before Stop was admitted.', 409)
      }
      const owner: ControlOwnerBinding = { conversationId: current.id,
        ...(stopping && current.activeRequestId ? { requestId: current.activeRequestId } : {}),
        ...(stopping && current.nativeSessionId ? { nativeSessionId: current.nativeSessionId } : {}),
        ...(stopping && current.nativeTurnId ? { nativeTurnId: current.nativeTurnId } : {}) }
      const canceled = !stopping || input.scope === 'active_and_queued'
        ? await this.cancelQueuedLocked(tx, target, input) : { affected: [], changed: false }
      const affected = canceled.affected
      if (owner.requestId) {
        const active = (await tx.query<{ id: string }>(`select id from chat_delivery_commands
          where target_hash=$1 and command_id=$2 and owner_admission='owner_admitted'`,
        [commandInputHash(target), owner.requestId])).rows[0]
        if (active && !affected.includes(active.id)) affected.push(active.id)
      }
      if (owner.requestId) await tx.query(`update operator_conversations set cancel_requested=true,
        turn_state='canceling',revision=revision+1,updated_at=now() where id=$1 and active_request_id=$2`, [current.id, owner.requestId])
      const receipt: ChatControlReceipt = { commandId: input.commandId, target,
        operation: stopping ? input.scope === 'active_turn' ? 'stop_active' : 'stop_active_and_queued'
          : input.selection.kind === 'one' ? 'cancel_one' : 'cancel_all_queued',
        state: owner.requestId ? 'settling' : 'completed', affectedReceiptIds: affected, replayed: false }
      await this.controls.recordLocked(tx, principal.id, input, receipt, owner)
      return { receipt, replayed: false, owner, changed: canceled.changed || Boolean(owner.requestId) }
    }, { conflictRetries: 2 })
    if (!result.replayed) for (const receiptId of result.receipt.affectedReceiptIds) await this.hooks.changed?.(receiptId)
    if (result.changed) await this.hooks.conversationChanged?.(target)
    if (result.replayed || !result.owner.requestId) return result.receipt
    try {
      await this.hooks.dispatchStop(principal, target, result.owner)
      const active = (await this.pool.query<{ active_request_id: string | null }>(
        'select active_request_id from operator_conversations where id=$1', [target.conversationId])).rows[0]
      return this.controls.update(principal.id, input.commandId,
        active?.active_request_id === result.owner.requestId ? 'settling' : 'completed')
    } catch (error) {
      return this.controls.update(principal.id, input.commandId, 'unknown',
        error instanceof DomainError ? error.code : 'CHAT_STOP_UNCONFIRMED')
    }
  }

  private async cancelQueuedLocked(tx: TransactionSql, target: ConversationTarget,
    input: RetainedControlRequest): Promise<{ affected: string[]; changed: boolean }> {
    const one = 'selection' in input && input.selection.kind === 'one' ? input.selection.receiptId : undefined
    const commands = one ? await this.receipts.forTarget(target, undefined, 1, one, tx) : await this.receipts.unfinishedForTarget(target, tx)
    if (one && !commands.length) throw new DomainError('CHAT_RECEIPT_NOT_FOUND', 'That queued receipt does not belong to this conversation.', 404)
    // Native admission and cancellation share the conversation lock. Lock receipt rows before channel rows.
    await tx.query('select id from chat_delivery_commands where id=any($1::text[]) order by id for update', [commands.map(item => item.receipt.id)])
    const affected: string[] = []
    for (const saved of commands) {
      const current = await this.receipts.byReceipt(saved.receipt.id, tx)
      if (!current || current.receipt.state === 'canceled') continue
      if (current.receipt.state !== 'queued') {
        if (one) throw new DomainError('CHAT_QUEUE_TARGET_SETTLED', 'This input is no longer queued; cancellation did not stop its active work.', 409)
        continue
      }
      const turn = (await tx.query<{ delivery: string | null; active: boolean }>(`select t.delivery,
        c.active_request_id=t.request_id as active from operator_conversation_turns t
        join operator_conversations c on c.id=t.conversation_id where c.id=$1 and t.request_id=$2`,
      [target.conversationId, current.request.commandId])).rows[0]
      if (current.ownerAdmission === 'owner_admitted' && (!turn || !['queued', 'canceled'].includes(turn.delivery ?? '') || turn.active)) {
        if (one) throw new DomainError('CHAT_QUEUE_TARGET_SETTLED', 'This input has left the queue; cancellation did not stop its active work.', 409)
        continue
      }
      await tx.query(`update operator_conversation_turns set delivery='canceled',updated_at=now()
        where conversation_id=$1 and request_id=$2 and delivery='queued'`, [target.conversationId, current.request.commandId])
      await this.receipts.updateLocked(tx, { ...current.receipt, state: 'canceled', updatedAt: new Date().toISOString() })
      affected.push(current.receipt.id)
    }
    const canceledLegacy = !one ? await tx.query(`update operator_conversation_turns set delivery='canceled',updated_at=now()
      where conversation_id=$1 and delivery='queued' and request_id is distinct from (
        select active_request_id from operator_conversations where id=$1)`, [target.conversationId]) : undefined
    if (affected.length || canceledLegacy?.rowCount) await tx.query('update operator_conversations set revision=revision+1,updated_at=now() where id=$1', [target.conversationId])
    return { affected, changed: Boolean(affected.length || canceledLegacy?.rowCount) }
  }
}
