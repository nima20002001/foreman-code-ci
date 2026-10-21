import { omitProperties } from '../../shared/omitProperties.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import {
  ChatDeliveryReceiptSchema, ChatSendRequestSchema,
  type ChatDeliveryReceipt, type ChatSendRequest, type DeliveryTarget,
} from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { withTransaction, type TransactionSql } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import type { StoredDelivery, DeliveryOwnerBinding, DeliveryQualification } from './model.js'
import { effectiveInput, isTerminalReceipt, receiptId } from './validation.js'

interface StoredRow {
  principal_id: string; request: unknown; receipt: unknown; input_hash: string;
  owner_admission: StoredDelivery['ownerAdmission']; sequence: string; revision: string
  owner_binding: DeliveryOwnerBinding
}
type Query = SqlQuery
function stored(row: StoredRow): StoredDelivery {
  const request = ChatSendRequestSchema.parse(row.request)
  if (!request.commandId) throw new Error('A durable chat command has no identity.')
  return { principalId: row.principal_id, request: { ...request, commandId: request.commandId },
    receipt: ChatDeliveryReceiptSchema.parse(row.receipt), inputHash: row.input_hash,
    ownerAdmission: row.owner_admission, ownerBinding: row.owner_binding,
    sequence: Number(row.sequence), revision: Number(row.revision) }
}

/** One receipt journal is shared by Group, direct chat and the native owner. */
export class PostgresChatDeliveryRepository {
  constructor(readonly pool: pg.Pool) {}

  async find(principalId: string, commandId: string, tx: Query = this.pool): Promise<StoredDelivery | undefined> {
    const row = (await tx.query<StoredRow>(`select * from chat_delivery_commands
      where principal_id=$1 and command_id=$2`, [principalId, commandId])).rows[0]
    return row ? stored(row) : undefined
  }

  async byReceipt(id: string, tx: Query = this.pool): Promise<StoredDelivery | undefined> {
    const row = (await tx.query<StoredRow>('select * from chat_delivery_commands where id=$1', [id])).rows[0]
    return row ? stored(row) : undefined
  }

  /** Owning native journal supplies positive delivery evidence; this is not caller-provided targeting. */
  async bindNativeSessionLocked(tx: TransactionSql, receiptId: string, nativeSessionId: string): Promise<void> {
    await tx.query('select id from chat_delivery_commands where id=$1 for update', [receiptId])
    const command = await this.byReceipt(receiptId, tx)
    if (!command || command.ownerAdmission !== 'owner_admitted') throw new DomainError('CHAT_OWNER_ADMISSION_REQUIRED', 'Native evidence requires an admitted owner.', 409)
    if (command.ownerBinding.deliveredNativeSessionId && command.ownerBinding.deliveredNativeSessionId !== nativeSessionId) {
      throw new DomainError('CHAT_OWNER_IDENTITY_CONFLICT', 'This command was delivered to a different native session.', 409)
    }
    await tx.query(`update chat_delivery_commands set owner_binding=owner_binding || jsonb_build_object('deliveredNativeSessionId',$2::text)
      where id=$1`, [receiptId, nativeSessionId])
  }

  async prepareLocked(tx: TransactionSql, principalId: string, input: ChatSendRequest & { commandId: string },
    qualification: DeliveryQualification, channelId?: string): Promise<StoredDelivery> {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`chat-command:${principalId}:${input.commandId}`])
    await assertChatCommandKind(tx, principalId, input.commandId, 'delivery')
    if ((await tx.query('select 1 from chat_control_commands where principal_id=$1 and command_id=$2', [principalId, input.commandId])).rowCount) {
      throw new DomainError('CHAT_COMMAND_CONFLICT', 'This command already identifies a different control operation.', 409)
    }
    const prior = await this.find(principalId, input.commandId, tx)
    const inputHash = effectiveInput(input)
    if (prior) {
      if (prior.inputHash !== inputHash) throw new DomainError('CHAT_COMMAND_CONFLICT', 'This command already identifies a different message or target.', 409)
      return prior
    }
    const { appliedIntent, ownerBinding } = qualification
    if (appliedIntent === 'steer' && (!ownerBinding.nativeTurnId || !ownerBinding.ownerRequestId || !ownerBinding.nativeSessionId)) {
      throw new DomainError('CHAT_STEER_UNAVAILABLE', 'Steering requires a qualified exact native owner and turn.', 409)
    }
    if (input.expectedNativeTurnId && input.expectedNativeTurnId !== ownerBinding.nativeTurnId) {
      throw new DomainError('CHAT_TARGET_CHANGED', 'The addressed native turn changed before admission.', 409)
    }
    const now = new Date().toISOString()
    const receipt = ChatDeliveryReceiptSchema.parse({ id: receiptId(principalId, input.commandId), commandId: input.commandId,
      ...(input.sourcePostId ? { postId: input.sourcePostId } : {}), target: input.target,
      requestedIntent: input.intent, appliedIntent, state: 'queued', createdAt: now, updatedAt: now })
    const scope = input.target.kind === 'operator_conversation' ? undefined : input.target.agent
    const result = await tx.query<StoredRow>(`insert into chat_delivery_commands
      (id,command_id,principal_id,workspace_id,workflow_id,channel_id,post_id,target_hash,input_hash,request,receipt,owner_admission,owner_binding)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,'prepared',$12::jsonb) returning *`,
    [receipt.id, input.commandId, principalId, scope?.workspaceId ?? null, scope?.workflowId ?? null,
      channelId ?? null, input.sourcePostId ?? null, commandInputHash(input.target), inputHash,
      JSON.stringify(input), JSON.stringify(receipt), JSON.stringify(ownerBinding)])
    return stored(result.rows[0]!)
  }

  /** Called by deliver under the real owner's lock. Its journal and CAS commit together before native I/O. */
  async adoptPreparedLocked<T>(tx: TransactionSql, principalId: string, input: ChatSendRequest & { commandId: string },
    persistOwnerAdmission: (command: StoredDelivery) => Promise<T>): Promise<{ command: StoredDelivery; adopted: boolean; owner?: T }> {
    const row = (await tx.query<StoredRow>(`select * from chat_delivery_commands
      where principal_id=$1 and command_id=$2 for update`, [principalId, input.commandId])).rows[0]
    if (!row) throw new DomainError('CHAT_COMMAND_NOT_FOUND', 'The prepared message is not available to its owner.', 404)
    const command = stored(row)
    if (command.inputHash !== effectiveInput(input)) throw new DomainError('CHAT_COMMAND_CONFLICT', 'The owner command differs from the retained message.', 409)
    if (command.ownerAdmission === 'owner_admitted' || command.receipt.state !== 'queued') return { command, adopted: false }
    const owner = await persistOwnerAdmission(command)
    await tx.query(`update chat_delivery_commands set owner_admission='owner_admitted',revision=revision+1,updated_at=now()
      where id=$1 and owner_admission='prepared'`, [command.receipt.id])
    return { command: { ...command, ownerAdmission: 'owner_admitted', revision: command.revision + 1 }, adopted: true, owner }
  }

  async updateLocked(tx: TransactionSql, receipt: ChatDeliveryReceipt): Promise<boolean> {
    const next = ChatDeliveryReceiptSchema.parse(receipt)
    const row = (await tx.query<StoredRow>('select * from chat_delivery_commands where id=$1 for update', [next.id])).rows[0]
    if (!row) throw new DomainError('CHAT_RECEIPT_NOT_FOUND', 'The retained receipt does not exist.', 404)
    const previous = stored(row).receipt
    const identity = (value: ChatDeliveryReceipt) => [value.id, value.commandId, value.target, value.postId ?? null,
      value.requestedIntent, value.appliedIntent, value.createdAt]
    if (commandInputHash(identity(previous)) !== commandInputHash(identity(next))) {
      throw new DomainError('CHAT_RECEIPT_IDENTITY_CONFLICT', 'Receipt identity and original target are immutable.', 409)
    }
    for (const field of ['nativeTurnId', 'consultationId', 'continuationId', 'continuationExecution', 'replyPostId'] as const) {
      if (previous[field] !== undefined && commandInputHash(previous[field]) !== commandInputHash(next[field] ?? null)) {
        throw new DomainError('CHAT_RECEIPT_BINDING_CONFLICT', 'Recorded native, continuation and reply identities cannot change.', 409)
      }
    }
    if (row.owner_admission === 'prepared' && !['queued', 'failed', 'canceled'].includes(next.state)) {
      throw new DomainError('CHAT_OWNER_ADMISSION_REQUIRED', 'The owner must durably adopt input before reporting native progress.', 409)
    }
    if (commandInputHash(previous) === commandInputHash(next)) return false
    if (isTerminalReceipt(previous)) {
      const withoutReply = (value: ChatDeliveryReceipt) => {
        const retained = omitProperties(value, ['replyPostId', 'updatedAt'])
        return retained
      }
      const linksReply = !previous.replyPostId && next.replyPostId
        && commandInputHash(withoutReply(previous)) === commandInputHash(withoutReply(next))
      if (!linksReply) throw new DomainError('CHAT_RECEIPT_SETTLED', 'A settled receipt cannot be reinterpreted.', 409)
    }
    if (row.owner_admission === 'owner_admitted' && next.state === 'queued' && previous.state !== 'queued') {
      throw new DomainError('CHAT_RECEIPT_REDISPATCH_DENIED', 'Admitted input cannot be reset for native resubmission.', 409)
    }
    await tx.query('update chat_delivery_commands set receipt=$2::jsonb,revision=revision+1,updated_at=now() where id=$1',
      [next.id, JSON.stringify(next)])
    await tx.query(`update workflow_chat_channels set revision=revision+1 where id=(
      select channel_id from chat_delivery_commands where id=$1)`, [next.id])
    return true
  }

  async update(receipt: ChatDeliveryReceipt): Promise<boolean> {
    return withTransaction(this.pool, tx => this.updateLocked(tx, receipt), { conflictRetries: 2 })
  }

  async rejectPrepared(id: string, errorCode: string): Promise<ChatDeliveryReceipt> {
    return withTransaction(this.pool, async tx => {
      const row = (await tx.query<StoredRow>('select * from chat_delivery_commands where id=$1 for update', [id])).rows[0]
      if (!row) throw new DomainError('CHAT_RECEIPT_NOT_FOUND', 'The retained receipt does not exist.', 404)
      const current = stored(row)
      if (current.ownerAdmission !== 'prepared' || current.receipt.state !== 'queued') return current.receipt
      const receipt = { ...current.receipt, state: 'failed' as const, errorCode, updatedAt: new Date().toISOString() }
      await this.updateLocked(tx, receipt)
      return receipt
    }, { conflictRetries: 2 })
  }

  /** Prepared work can be retried only by the internal drain, never by public command replay. */
  async pending(limit = 32): Promise<StoredDelivery[]> {
    const rows = await this.pool.query<StoredRow>(`select * from chat_delivery_commands
      where owner_admission='prepared' and receipt->>'state'='queued' order by sequence limit $1`, [Math.min(100, Math.max(1, limit))])
    return rows.rows.map(stored)
  }

  async forTarget(target: DeliveryTarget, before: number | undefined, limit: number, receipt?: string, sql: Query = this.pool): Promise<StoredDelivery[]> {
    const rows = await sql.query<StoredRow>(`select * from chat_delivery_commands where target_hash=$1
      and ($2::bigint is null or sequence<$2) and ($3::text is null or id=$3)
      order by sequence desc limit $4`, [commandInputHash(target), before ?? null, receipt ?? null, limit])
    return rows.rows.map(stored)
  }

  async targetRevision(target: DeliveryTarget, sql: Query = this.pool): Promise<number> {
    const result = await sql.query<{ revision: string }>(`select coalesce(sum(revision),0)::text as revision
      from chat_delivery_commands where target_hash=$1`, [commandInputHash(target)])
    return Number(result.rows[0]?.revision ?? 0)
  }

  async targetSnapshot(target: DeliveryTarget, before: number | undefined, limit: number, receipt?: string) {
    return withTransaction(this.pool, async tx => ({ rows: await this.forTarget(target, before, limit, receipt, tx),
      revision: await this.targetRevision(target, tx) }), { isolation: 'repeatable read', readOnly: true })
  }

  async forPost(postId: string, tx: Query = this.pool): Promise<StoredDelivery[]> {
    return (await tx.query<StoredRow>('select * from chat_delivery_commands where post_id=$1 order by sequence', [postId])).rows.map(stored)
  }

  async unfinishedForTarget(target: DeliveryTarget, tx: Query = this.pool): Promise<StoredDelivery[]> {
    return (await tx.query<StoredRow>(`select * from chat_delivery_commands where target_hash=$1
      and receipt->>'state' in ('queued','submitting','accepted','unknown') order by sequence`, [commandInputHash(target)])).rows.map(stored)
  }
}
import { assertChatCommandKind } from './commandIdentity.js'
