import type { MemoryWorkPageInfo, MemoryWorkSummary } from '@foreman-code/contracts'
import type {
  AgentIdentity, AgentNodeRef, AgentSubject, ExecutionRef, LogicalWorkRef, MemoryBoard,
  MemoryBoardMutation, MemoryBoardScope, MemoryCard, MemoryCardWorkBinding,
  MemoryCardWorkClaim, MemoryNote,
} from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphTransactionSql } from '../run-graph/connection.js'

export type MemoryTool = 'memory_board_get' | 'memory_board_changes_read'
  | 'memory_card_create' | 'memory_card_update' | 'memory_note_create'
  | 'memory_note_update' | 'memory_note_archive'
export const memoryReadTools = ['memory_board_get', 'memory_board_changes_read'] as const
export const memoryWriteTools = ['memory_card_create', 'memory_card_update',
  'memory_note_create', 'memory_note_update', 'memory_note_archive'] as const
export interface Actor { kind: 'operator' | 'agent' | 'engine'; id: string; displayName: string }
export interface Page<T> { items: T[]; nextCursor: string | null; hasMore: boolean; revision: number }
export interface Counts { todo: number; doing: number; waiting_for_user: number; blocked: number; done: number; completed: number; dropped: number; notes: number }
export interface BoardRow { board: MemoryBoard; sequence: number; counts: Counts; nextNoteRank: number }
export interface MutationReceipt {
  commandId: string; outcome: 'created' | 'existing' | 'updated' | 'unchanged'
  card?: MemoryCard; note?: MemoryNote
  bindings: MemoryCardWorkBinding[]; claims: MemoryCardWorkClaim[]; boardRevision: number
}
export interface BoardChange {
  id: string; boardId: string; sequence: number; boardRevision: number
  entity: 'card' | 'note'; entityId: string; entityRevision: number
  commandId?: string; sourceEventKey?: string; actor: Actor; occurredAt: string
  provenance?: { principalId?: string; subject?: AgentSubject; work?: LogicalWorkRef; execution?: ExecutionRef }
  changes?: Record<string, { before: unknown; after: unknown }>
}
export interface BoardSnapshot {
  board: MemoryBoard
  openColumns: (Page<MemoryCard> & { status: 'todo' | 'doing' | 'waiting_for_user' | 'blocked' })[]
  notes: Page<MemoryNote>; counts: Counts; sequence: number
}
export interface CardDetail {
  card: MemoryCard; bindings: MemoryCardWorkBinding[]; claims: MemoryCardWorkClaim[]
  bindingPage: MemoryWorkPageInfo; claimPage: MemoryWorkPageInfo; workSummary: MemoryWorkSummary
  history: Page<BoardChange>
}
export type CommandRead = { commandId: string; state: 'known'; receipt: MutationReceipt }
  | { commandId: string; state: 'rejected'; error: { code: string; message: string; status: number; details?: Record<string, unknown> } }
  | { commandId: string; state: 'unknown' }
export interface ChangesPage extends Page<BoardChange> { watermark: number; resetRequired: boolean }
export interface ReadRequest {
  scope?: MemoryBoardScope | undefined; boardId?: string | undefined
  view?: 'board' | 'cards' | 'card' | 'notes' | 'command' | 'bindings' | 'claims' | undefined
  status?: MemoryCard['status'] | undefined; completionKind?: 'completed' | 'dropped' | undefined; query?: string | undefined
  cardId?: string | undefined; commandId?: string | undefined; archived?: boolean | undefined; cursor?: string | undefined; limit?: number | undefined
}
export interface ChangesRequest { boardId: string; afterSequence?: number | undefined; cursor?: string | undefined; limit?: number | undefined }
export type ReadResult = BoardSnapshot | Page<MemoryCard> | Page<MemoryNote> | Page<MemoryCardWorkBinding> | Page<MemoryCardWorkClaim> | CardDetail | CommandRead
export interface SubjectAccess {
  principalId: string; subject: AgentSubject; tools: readonly string[]; readOnly: boolean
  /** Saved, server-resolved branch membership for digest selection; never model input. */
  branchNodeIds: readonly string[]
}
export interface ResolvedWork {
  node: AgentNodeRef; work: LogicalWorkRef; state: MemoryCardWorkBinding['state']
  currentExecutionId: string | null; reason: string | null; parentRequestId?: string
  /** Interval checks have execution identity but do not create business obligations. */
  isBusinessWork: boolean
}
/** D supplies existing live principal/configuration and saved workflow resolvers.
 * These functions use only the supplied SQL transaction: no native/network I/O.
 * Missing adapters must keep the feature unavailable, never grant fallback access. */
export interface MemoryBoardAuthority {
  caller(tx: GraphTransactionSql, principal: ManagementPrincipal): Promise<SubjectAccess | null>
  subject(tx: GraphTransactionSql, subject: AgentSubject): Promise<SubjectAccess>
  scope(tx: GraphTransactionSql, scope: MemoryBoardScope): Promise<void>
  node(tx: GraphTransactionSql, node: AgentNodeRef, scope: MemoryBoardScope): Promise<void>
  work(tx: GraphTransactionSql, work: LogicalWorkRef): Promise<ResolvedWork>
  currentWork(tx: GraphTransactionSql, subject: AgentSubject): Promise<ResolvedWork | null>
  sourcePost(tx: GraphTransactionSql, postId: string, scope: MemoryBoardScope,
    caller: ManagementPrincipal | AgentSubject): Promise<void>
  /** Recheck authoritative saved node/work/execution identity at engine seams. */
  lifecycle(tx: GraphTransactionSql, agent: AgentIdentity, work: LogicalWorkRef,
    executionId?: string): Promise<void>
}
export interface MemoryBoardDependencies {
  transaction<T>(perform: (tx: GraphTransactionSql) => Promise<T>): Promise<T>
  readTransaction<T>(perform: (tx: GraphTransactionSql) => Promise<T>): Promise<T>
  authority: MemoryBoardAuthority
  /** Notifications only wake readback; PostgreSQL delivers them after commit. */
  listen(boardId: string, changed: () => void, disconnected: () => void): Promise<() => void>
  now?: () => Date
}
export interface MutationContext {
  actor: Actor; principalId: string; subject?: AgentSubject
  caller: ManagementPrincipal | AgentSubject; tool: MemoryTool
}
export type Operation = MemoryBoardMutation & { commandId: string }
