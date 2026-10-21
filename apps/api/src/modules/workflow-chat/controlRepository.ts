import type { SqlQuery } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { ChatControlReceiptSchema, type ChatControlReceipt, type ChatStopRequest,
  type ChatQueueCancelRequest, type DeliveryTarget } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { effectiveInput } from './validation.js'

export type RetainedControlRequest = (ChatStopRequest | ChatQueueCancelRequest) & { commandId: string }
export interface ControlOwnerBinding { conversationId: string; requestId?: string; nativeSessionId?: string; nativeTurnId?: string }
export interface StoredControl {
  request: RetainedControlRequest; receipt: ChatControlReceipt; ownerBinding: ControlOwnerBinding; inputHash: string
}
type Query = SqlQuery

/** Command replay reads the admitted effective operation before looking at a current native owner. */
export class PostgresChatControlRepository {
  constructor(private readonly pool: pg.Pool) {}

  async find(principalId: string, commandId: string, sql: Query = this.pool): Promise<StoredControl | undefined> {
    const row = (await sql.query<{ request: RetainedControlRequest; receipt: unknown;
      owner_binding: ControlOwnerBinding; input_hash: string }>(`select * from chat_control_commands
      where principal_id=$1 and command_id=$2`, [principalId, commandId])).rows[0]
    if (!row) return undefined
    let receipt = ChatControlReceiptSchema.parse(row.receipt)
    if (row.owner_binding.requestId && ['settling', 'unknown', 'recorded'].includes(receipt.state)) {
      const terminal = (await sql.query<{ settled: boolean }>(`select
        (result is not null or delivery in ('completed','failed','canceled')) as settled
        from operator_conversation_turns where conversation_id=$1 and request_id=$2`,
      [row.owner_binding.conversationId, row.owner_binding.requestId])).rows[0]?.settled
      if (terminal) {
        const updated = (await sql.query<{ receipt: unknown }>(`update chat_control_commands set receipt=(receipt - 'errorCode') || '{"state":"completed"}'::jsonb
          where principal_id=$1 and command_id=$2 and receipt->>'state' in ('settling','unknown','recorded') returning receipt`,
        [principalId, commandId])).rows[0]
        if (updated) receipt = ChatControlReceiptSchema.parse(updated.receipt)
      }
    }
    return { request: row.request, receipt, ownerBinding: row.owner_binding, inputHash: row.input_hash }
  }

  replay(value: StoredControl, input: RetainedControlRequest): ChatControlReceipt {
    if (value.inputHash !== effectiveInput(input)) throw new DomainError('CHAT_COMMAND_CONFLICT',
      'This command already identifies a different control or target.', 409)
    return { ...value.receipt, replayed: true }
  }

  async recordLocked(tx: TransactionSql, principalId: string, input: RetainedControlRequest,
    receipt: ChatControlReceipt, owner: ControlOwnerBinding): Promise<void> {
    await tx.query(`insert into chat_control_commands(principal_id,command_id,input_hash,request,receipt,owner_binding)
      values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)`, [principalId, input.commandId, effectiveInput(input),
      JSON.stringify(input), JSON.stringify(ChatControlReceiptSchema.parse(receipt)), JSON.stringify(owner)])
  }

  async update(principalId: string, commandId: string, state: ChatControlReceipt['state'], errorCode?: string): Promise<ChatControlReceipt> {
    const row = (await this.pool.query<{ receipt: unknown }>(`update chat_control_commands set receipt=(receipt - 'errorCode') ||
      jsonb_build_object('state',$3::text) || case when $4::text is null then '{}'::jsonb else jsonb_build_object('errorCode',$4::text) end
      where principal_id=$1 and command_id=$2 and receipt->>'state' not in ('completed','failed') returning receipt`,
    [principalId, commandId, state, errorCode ?? null])).rows[0]
    if (row) return ChatControlReceiptSchema.parse(row.receipt)
    const existing = await this.find(principalId, commandId)
    if (!existing) throw new DomainError('CHAT_CONTROL_NOT_FOUND', 'The control receipt is unavailable.', 404)
    return existing.receipt
  }

  async read(principalId: string, commandId: string, target: DeliveryTarget): Promise<ChatControlReceipt | undefined> {
    const value = await this.find(principalId, commandId)
    if (!value || commandInputHash(value.request.target) !== commandInputHash(target)) return undefined
    return value.receipt
  }
}
