import { randomUUID } from 'node:crypto'
import {
  ChatDeliveryReceiptSchema, ChatQueueCancelRequestSchema, ChatSendRequestSchema, ChatStopRequestSchema,
  DeliveryTargetSchema, type ChatSendRequest, type ChatDeliveryReceipt, type DeliveryTarget,
  type ChatControlReceipt, type ChatStopRequest, type ChatQueueCancelRequest,
} from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ExecutionChatPort } from '../collaboration/ports.js'
import { withTransaction, type TransactionSql } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import { validateChatInput } from '../conversations/nativeChatInput.js'
import { effectiveInput } from './validation.js'
import type { PostgresChatDeliveryRepository } from './deliveryRepository.js'
import type { ChatTargetRead, StoredDelivery, DeliveryQualification } from './model.js'
import { readRetainedDeliveryInputs, type DeliveryInputRead } from './retainedInputs.js'
import { PostgresChatControlRepository } from './controlRepository.js'

export interface ConversationDeliveryPort extends Pick<ExecutionChatPort, 'deliver' | 'stop' | 'cancel'> {
  read(principal: ManagementPrincipal, request: { target: DeliveryTarget; cursor?: string | undefined; limit?: number | undefined }): Promise<ChatTargetRead>
}
export interface ChatTargetAuthority {
  authenticate(principal: ManagementPrincipal, target: DeliveryTarget, action: 'read' | 'write' | 'cancel'): Promise<ManagementPrincipal>
  authorizeLocked(tx: TransactionSql, principal: ManagementPrincipal, target: DeliveryTarget,
    action: 'read' | 'write' | 'cancel'): Promise<void>
  /** Includes full prepared-envelope preflight; no native submission may occur here. */
  qualifyLocked(tx: TransactionSql, principal: ManagementPrincipal, request: ChatSendRequest): Promise<DeliveryQualification>
  /** Resolves existing authenticated identity for an internal pending drain; never issues a new credential. */
  restorePrincipal(principalId: string): Promise<ManagementPrincipal>
}
export interface LegacyChatAdmission {
  inputHash: string
  beforeQualifyLocked?(tx: TransactionSql): Promise<void>
  qualifyLocked?(tx: TransactionSql, principal: ManagementPrincipal, request: ChatSendRequest): Promise<DeliveryQualification>
}

export class ChatDeliveryRouter {
  constructor(readonly repository: PostgresChatDeliveryRepository, private readonly authority: ChatTargetAuthority,
    private readonly execution: ExecutionChatPort, private readonly agent: ConversationDeliveryPort,
    private readonly operator: ConversationDeliveryPort) {}

  private owner(target: DeliveryTarget): ExecutionChatPort | ConversationDeliveryPort {
    if (target.kind === 'agent_conversation') return this.agent
    if (target.kind === 'operator_conversation') return this.operator
    return this.execution
  }

  async send(principal: ManagementPrincipal, raw: unknown, legacy?: LegacyChatAdmission): Promise<ChatDeliveryReceipt> {
    const parsed = ChatSendRequestSchema.parse(raw)
    const input = { ...parsed, commandId: parsed.commandId ?? randomUUID() }
    const caller = await this.authority.authenticate(principal, input.target, 'read')
    const prior = await this.repository.find(caller.id, input.commandId)
    if (prior) return this.replay(prior, input, legacy?.inputHash)
    if (await new PostgresChatControlRepository(this.repository.pool).find(caller.id, input.commandId)) {
      throw new DomainError('CHAT_COMMAND_CONFLICT', 'This command already identifies a different control operation.', 409)
    }
    validateChatInput(input)
    const prepared = await withTransaction(this.repository.pool, async tx => {
      await this.authority.authorizeLocked(tx, caller, input.target, 'read')
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`chat-command:${caller.id}:${input.commandId}`])
      const found = await this.repository.find(caller.id, input.commandId, tx)
      if (found) { this.replay(found, input, legacy?.inputHash); return { command: found, replayed: true } }
      await this.authority.authorizeLocked(tx, caller, input.target, 'write')
      await legacy?.beforeQualifyLocked?.(tx)
      const qualification = await (legacy?.qualifyLocked ?? this.authority.qualifyLocked.bind(this.authority))(tx, caller, input)
      if (legacy) qualification.ownerBinding.legacyInputHash = legacy.inputHash
      return { command: await this.repository.prepareLocked(tx, caller.id, input, qualification), replayed: false }
    }, { conflictRetries: 2 })
    if (prepared.replayed) return prepared.command.receipt
    try { return await this.dispatchPrepared(caller, prepared.command) }
    catch (error) {
      // Persistence has already succeeded: a transport/owner error must not masquerade as a
      // pre-admission 4xx and invite the caller to create another command.
      return this.retainDispatchFailure(prepared.command, error)
    }
  }

  private replay(prior: StoredDelivery, input: ChatSendRequest, legacyInputHash?: string): ChatDeliveryReceipt {
    if (legacyInputHash && prior.ownerBinding.legacyInputHash && legacyInputHash !== prior.ownerBinding.legacyInputHash) {
      throw new DomainError('CHAT_COMMAND_CONFLICT', 'The retained legacy command has different accepted input or settings.', 409)
    }
    if (prior.inputHash !== effectiveInput(input)) throw new DomainError('CHAT_COMMAND_CONFLICT', 'This command already identifies a different message or target.', 409)
    return prior.receipt
  }

  /** Only this internal path re-drives prepared admission. The real owner claims it atomically. */
  async dispatchPrepared(principal: ManagementPrincipal, prepared: StoredDelivery): Promise<ChatDeliveryReceipt> {
    const current = await this.repository.find(principal.id, prepared.request.commandId)
    if (!current) throw new DomainError('CHAT_COMMAND_NOT_FOUND', 'The retained command is no longer available.', 404)
    if (current.ownerAdmission !== 'prepared' || current.receipt.state !== 'queued') return current.receipt
    const result = ChatDeliveryReceiptSchema.parse(await this.owner(current.request.target).deliver(principal, current.request))
    if (result.id !== current.receipt.id || result.commandId !== current.request.commandId) {
      throw new DomainError('CHAT_OWNER_RECEIPT_CONFLICT', 'The native owner returned a different receipt identity.', 409)
    }
    const owned = await this.repository.byReceipt(result.id)
    if (!owned || owned.ownerAdmission !== 'owner_admitted' && !['failed', 'canceled'].includes(owned.receipt.state)) {
      throw new DomainError('CHAT_OWNER_ADMISSION_REQUIRED', 'The native owner must durably adopt this exact receipt before dispatch.', 503)
    }
    // Owner persistence is authoritative, including another callback winning after the response was formed.
    return owned.receipt
  }

  async drainPrepared(limit = 32): Promise<void> {
    const pending = await this.repository.pending(limit)
    for (const command of pending) {
      try {
        const principal = await this.authority.restorePrincipal(command.principalId)
        await this.authority.authenticate(principal, command.request.target, 'write')
        await this.dispatchPrepared(principal, command)
      } catch (error) {
        await this.retainDispatchFailure(command, error)
      }
    }
  }

  private async retainDispatchFailure(command: StoredDelivery, error: unknown): Promise<ChatDeliveryReceipt> {
    const current = await this.repository.byReceipt(command.receipt.id)
    if (!current) throw new DomainError('CHAT_COMMAND_NOT_FOUND', 'The retained command is no longer available.', 404)
    // The owner journal alone reconciles possible submission after its admission commit.
    if (current.ownerAdmission !== 'prepared' || current.receipt.state !== 'queued') return current.receipt
    const rejected = error instanceof DomainError && [401, 403, 404, 409, 413, 422].includes(error.status)
      && !error.code.startsWith('CHAT_OWNER_')
    if (rejected) {
      return this.repository.rejectPrepared(current.receipt.id, error.code)
    }
    this.onDrainError(error, current.receipt.id)
    return current.receipt
  }

  private onDrainError(error: unknown, id: string): void {
    componentLogger('engine').warn({ receiptId: id, err: error }, 'Chat prepared admission remains pending')
  }

  async read(principal: ManagementPrincipal, input: { target: DeliveryTarget; cursor?: string | undefined; limit?: number | undefined;
    commandId?: string | undefined; receiptId?: string | undefined; deliveryInputs?: DeliveryInputRead | undefined }) {
    const target = DeliveryTargetSchema.parse(input.target)
    const caller = await this.authority.authenticate(principal, target, 'read')
    if (input.receiptId) {
      const command = await this.repository.byReceipt(input.receiptId)
      if (!command || effectiveInput({ target: command.request.target }) !== effectiveInput({ target })) {
        throw new DomainError('CHAT_RECEIPT_NOT_FOUND', 'No receipt belongs to this exact target.', 404)
      }
      return { target, receipts: [command.receipt] }
    }
    if (input.commandId) {
      const command = await this.repository.find(caller.id, input.commandId)
      if (!command) {
        const control = await new PostgresChatControlRepository(this.repository.pool).read(caller.id, input.commandId, target)
        if (control) return { target, receipts: [], controls: [control] }
      }
      if (!command || effectiveInput({ target: command.request.target }) !== effectiveInput({ target })) {
        throw new DomainError('CHAT_RECEIPT_NOT_FOUND', 'No receipt belongs to this command and exact target.', 404)
      }
      return { target, receipts: [command.receipt] }
    }
    if (input.deliveryInputs) return { target, receipts: [],
      deliveryInputs: await readRetainedDeliveryInputs(this.repository, target, input.deliveryInputs) }
    const state = await this.owner(target).read(caller, { target, ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}) })
    return state
  }

  async stop(principal: ManagementPrincipal, raw: unknown): Promise<ChatControlReceipt> {
    const request: ChatStopRequest = ChatStopRequestSchema.parse(raw)
    const caller = await this.authority.authenticate(principal, request.target, 'read')
    return this.owner(request.target).stop(caller, request)
  }

  async cancel(principal: ManagementPrincipal, raw: unknown): Promise<ChatControlReceipt> {
    const request: ChatQueueCancelRequest = ChatQueueCancelRequestSchema.parse(raw)
    const caller = await this.authority.authenticate(principal, request.target, 'read')
    return this.owner(request.target).cancel(caller, request)
  }
}
