import type {
  AgentSubject, BoardApplicationReceipt, BoardDigest, BoardLifecycleFact, BoardResult,
  BrowserPrepareResult, BrowserReleaseResult, ChatControlReceipt, ChatDeliveryReceipt,
  ChatQueueCancelRequest, ChatSendRequest, ChatStopRequest, DeliveryTarget,
  EngineChatReadback, ExecutionRef, LogicalWorkRef, NodeBrowserSettings,
} from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphTransactionSql } from '../run-graph/connection.js'

/** The existing owner transaction and authenticated principal, not new authorities. */
export type GraphTransaction = GraphTransactionSql
export type Principal = ManagementPrincipal

export interface MemoryBoardPort {
  readDigest(input: { subject: AgentSubject; work?: LogicalWorkRef }): Promise<BoardDigest>
  applyResultLocked(tx: GraphTransaction, input: {
    subject: AgentSubject; execution: ExecutionRef; work: LogicalWorkRef
    sourceEventKey: string; result: BoardResult
  }): Promise<BoardApplicationReceipt>
  applyLifecycleLocked(tx: GraphTransaction, fact: BoardLifecycleFact): Promise<BoardApplicationReceipt>
}

/** Only workflow_execution/workflow_coordinator targets belong to the Run owner. */
export interface ExecutionChatPort {
  deliver(principal: Principal, request: ChatSendRequest): Promise<ChatDeliveryReceipt>
  read(principal: Principal, request: {
    target: DeliveryTarget; cursor?: string; limit?: number
  }): Promise<EngineChatReadback>
  stop(principal: Principal, request: ChatStopRequest): Promise<ChatControlReceipt>
  cancel(principal: Principal, request: ChatQueueCancelRequest): Promise<ChatControlReceipt>
}

/** Setup/cleanup runs outside graph transactions; this port never carries native addresses. */
export interface BrowserLifecyclePort {
  prepare(input: {
    subject: AgentSubject; browser: NodeBrowserSettings; computerId: string; commandId: string
  }): Promise<BrowserPrepareResult>
  release(input: {
    sessionId: string; subject: AgentSubject; commandId: string
    reason: 'terminal' | 'stop' | 'conversation_closed' | 'runtime_update'
  }): Promise<BrowserReleaseResult>
}

export interface CollaborationPorts {
  memoryBoards: MemoryBoardPort
  executionChat: ExecutionChatPort
  browser: BrowserLifecyclePort
}
