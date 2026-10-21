import type {
  AgentIdentity, ChatControlReceipt, ChatDeliveryReceipt, ChatSendRequest,
  CoordinatorConsultationBinding, DeliveryTarget, EngineChatMessage, EngineChatReadback,
  ExecutionRef, HarnessExecution, LogicalWorkRef, WorkflowControlContinuation,
} from '@foreman-code/contracts'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatRuntimeRun } from '../runs/repeatPostgres.js'
import type { Principal } from './ports.js'

export type WorkflowChatTarget = Extract<DeliveryTarget,
  { kind: 'workflow_execution' | 'workflow_coordinator' }>

/** Captured and rechecked by the existing native writer; never accepted from HTTP. */
export interface WorkflowChatNativeTarget {
  nativeSessionId: string
  ownerRequestId: string
  nativeTurnId?: string
  inputMessageId?: string
  /** Actual provider message/turn ID, absent before the provider acknowledges. */
  providerId?: string
  sessionMode: 'regular' | 'plan'
  steer: boolean
  interruptAndSend: boolean
}

/** The existing Run owner supplies this after locking Run, graph head and exact work.
 * A transaction here must not acquire another owner or perform native/network I/O. */
export interface WorkflowChatLockedTarget {
  sql: GraphTransactionSql
  run: RepeatRuntimeRun
  version: WorkflowVersionV3
  target: WorkflowChatTarget
  agent: AgentIdentity
  state: EngineChatReadback['state']
  execution?: HarnessExecution
  work?: LogicalWorkRef | undefined
  native?: WorkflowChatNativeTarget
  waiting?: {
    delegationGroupId: string
    waitingActivationId: string
    nativeSessionId: string
    sourceExecution: ExecutionRef
  }
  /** Terminal native evidence may be readable while this logical work is unaccepted. */
  accepted: boolean
  stopping: boolean
}

export interface WorkflowNativeChatPage {
  messages: EngineChatMessage[]
  nextCursor: string | null
  hasMore: boolean
  revision: number
}

export interface WorkflowChatAdmission {
  id: string
  principalId: string
  appliedIntent: 'steer' | 'next_turn' | 'interrupt_and_send'
  channelContext?: string
}

/** Implemented by the existing coordinator, not by the durable command service.
 * dispatch loads a committed command by ID and verifies its captured writer again.
 * It never invents a continuation or an input reservation. */
export interface WorkflowChatOwnerPort {
  transaction<T>(target: WorkflowChatTarget,
    work: (context: WorkflowChatLockedTarget) => Promise<T>): Promise<T>
  readNative(target: WorkflowChatTarget, input: {
    cursor?: string; limit: number; bindings: CoordinatorConsultationBinding[]
  }): Promise<WorkflowNativeChatPage>
  /** Read the actual qualified writer, without attaching or acquiring an owner. */
  observe(target: WorkflowChatTarget): Promise<Pick<EngineChatReadback, 'capabilities' | 'nativeTurnId'>>
  /** Check the exact serialized native/Worker envelope before durable admission. */
  validateAdmission(context: WorkflowChatLockedTarget, request: ChatSendRequest,
    admission: WorkflowChatAdmission): Promise<{ nativePrompt: string }>
  dispatch(target: WorkflowChatTarget, commandId: string): Promise<void>
}

export interface WorkflowControlCommand {
  id: string
  runId: string
  principalId: string
  target: WorkflowChatTarget
  kind: 'delivery' | 'stop' | 'cancel'
  operation: 'steer' | 'input' | 'interrupt' | 'stop' | 'consultation' | 'cancel'
  state: 'queued' | 'submitting' | 'accepted' | 'completed' | 'failed' | 'canceled' | 'unknown' | 'recorded' | 'settling'
  request: ChatSendRequest | null
  /** Full validated NativeTurnInput.prompt bytes, never a mutable input fragment. */
  nativePrompt?: string
  nativeTarget: WorkflowChatNativeTarget | null
  receipt: ChatDeliveryReceipt | ChatControlReceipt
  continuationId: string | null
  consultation: CoordinatorConsultationBinding | null
  deliveredExecution: ExecutionRef | null
}

/** The reservation, not a guessed execution count, owns supersession. B must use
 * reservedSuccessorExecutionId through normal input.bind in the same transaction. */
export type WorkflowControlDisposition =
  | { kind: 'ordinary' }
  | { kind: 'stopping'; commandId: string }
  | { kind: 'superseded'; continuation: WorkflowControlContinuation;
      reservedSuccessorExecutionId: string; request: ChatSendRequest }

export interface WorkflowQueuedInput {
  receiptId: string
  commandId: string
  originalTarget: WorkflowChatTarget
  deliveredExecution: ExecutionRef
  request: ChatSendRequest
  nativePrompt?: string
}

export interface WorkflowConsultationAdmission {
  binding: CoordinatorConsultationBinding
  agent: AgentIdentity
  commandId: string
  request: ChatSendRequest
  nativePrompt?: string
  sourceExecution: ExecutionRef
}

/** Produced only by the native observer after its existing positive closure or
 * terminal proof. Transport disconnects and cancellation acknowledgements are not settlement. */
export interface WorkflowConsultationSettlementEvidence {
  nativeSessionId: string
  ownerRequestId: string
  nativeTurnId?: string
  inputMessageId?: string
  observedAt: string
  source: 'native_terminal' | 'confirmed_closure'
  payload: Record<string, unknown>
}

export interface WorkflowExecutionChatDependencies {
  owner: WorkflowChatOwnerPort
  /** Existing file service checks ownership before any durable admission. */
  assertAttachments(principal: Principal, request: ChatSendRequest): Promise<void>
  now?: () => string
  id?: () => string
}
