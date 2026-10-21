import type {
  AgentIdentity, AgentSubject, ChatDeliveryReceipt, ChatSendRequest, DeliveryTarget,
  EngineChatReadback, WorkflowChatPost, WorkflowChatPostRequest, SendOperatorMessageRequest,
} from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import type { AcceptedChatInput } from '../conversations/nativeChatInput.js'

export interface ChannelScope { workspaceId: string; workflowId: string }
export interface ChannelRecord extends ChannelScope { id: string; revision: number; nextSequence: number }
export interface ChannelPage<T> { items: T[]; nextCursor: string | null; hasMore: boolean; revision: number }
export interface ChannelRead { cursor?: string | undefined; limit?: number | undefined; postId?: string | undefined; receiptId?: string | undefined;
  commandId?: string | undefined; runId?: string | undefined }
/** Private admission pins; public nativeTurnId may later identify the delivered continuation instead. */
export interface DeliveryOwnerBinding {
  agentIdentity?: AgentIdentity
  legacyInputHash?: string
  operatorInput?: SendOperatorMessageRequest
  configurationVersionId?: string
  ownerRequestId?: string
  nativeSessionId?: string
  deliveredNativeSessionId?: string
  nativeTurnId?: string
  inputMessageId?: string
  sessionMode?: 'regular' | 'plan'
  acceptedInput?: AcceptedChatInput
}
export interface DeliveryQualification {
  appliedIntent: ChatDeliveryReceipt['appliedIntent']
  ownerBinding: DeliveryOwnerBinding
}
export interface StoredDelivery {
  principalId: string
  request: ChatSendRequest & { commandId: string }
  receipt: ChatDeliveryReceipt
  inputHash: string
  ownerAdmission: 'prepared' | 'owner_admitted'
  ownerBinding: DeliveryOwnerBinding
  sequence: number
  revision: number
}

/** Shared access/selection resolves the authenticated actor and immutable target under its locks. */
export interface WorkflowChatAuthority {
  authenticate(principal: ManagementPrincipal, scope: ChannelScope, action: 'read' | 'write' | 'cancel'):
    Promise<{ principal: ManagementPrincipal; author: WorkflowChatPost['author']; subject?: AgentSubject }>
  authorizeLocked(tx: TransactionSql, principal: ManagementPrincipal, scope: ChannelScope,
    action: 'read' | 'write' | 'cancel'): Promise<void>
  /** Validate the full composed native envelope and exact target/configuration before any post/receipt write. */
  validateRecipientLocked(tx: TransactionSql, principal: ManagementPrincipal,
    request: ChatSendRequest & { commandId: string }, scope: WorkflowChatPostRequest): Promise<DeliveryQualification>
  validateLinksLocked(tx: TransactionSql, principal: ManagementPrincipal, request: WorkflowChatPostRequest): Promise<void>
}

/** Exact target reads keep standalone messages and Run-owned provenance in their original shapes. */
export type ChatTargetRead = EngineChatReadback | {
  target: DeliveryTarget
  state: unknown
  receipts: ChatDeliveryReceipt[]
  delivery: { state: EngineChatReadback['state']; capabilities: EngineChatReadback['capabilities']; nativeTurnId?: string }
}

export interface WorkflowChatChange {
  revision: number
  post?: WorkflowChatPost
  receipt?: ChatDeliveryReceipt
  snapshotRequired?: boolean
}
