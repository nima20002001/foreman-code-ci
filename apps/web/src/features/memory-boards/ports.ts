import type { MemoryWorkPageInfo, MemoryWorkSummary } from '@foreman-code/contracts'
import type { z } from 'zod'
import type {
  AgentNodeRef, AgentSubject, ExecutionRef, LogicalWorkRef, MemoryBoard, MemoryBoardScope, MemoryBoardMutation,
  MemoryCard, MemoryNote, MemoryCardWorkBinding, MemoryCardWorkClaim,
} from '@foreman-code/contracts'

/** Presentation projections over the canonical entities. C0 supplies their wire
 * validators at composition; this feature does not declare replacement schemas. */
export interface MemoryPage<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
  revision: number
}
export type CardStatus = MemoryCard['status']
export type OpenStatus = Exclude<CardStatus, 'done'>
export interface MemoryBoardView {
  board: MemoryBoard
  openColumns: Array<MemoryPage<MemoryCard> & { status: OpenStatus }>
  notes: MemoryPage<MemoryNote>
  counts: Record<CardStatus, number> & { completed: number; dropped: number; notes: number }
  sequence: number
}
export interface MemoryActor { kind: 'operator' | 'agent' | 'engine'; id: string; displayName: string }
export interface MemoryChange {
  id: string
  boardId: string
  sequence: number
  boardRevision: number
  entity: 'card' | 'note'
  entityId: string
  entityRevision: number
  commandId?: string
  sourceEventKey?: string
  actor: MemoryActor
  occurredAt: string
  provenance?: { principalId?: string; subject?: AgentSubject; work?: LogicalWorkRef; execution?: ExecutionRef }
  changes?: Record<string, { before: unknown; after: unknown }>
}
export interface MemoryCardDetail {
  card: MemoryCard
  bindings: MemoryCardWorkBinding[]
  claims: MemoryCardWorkClaim[]
  bindingPage: MemoryWorkPageInfo
  claimPage: MemoryWorkPageInfo
  workSummary: MemoryWorkSummary
  history: MemoryPage<MemoryChange>
}
export interface MemoryReceipt {
  commandId: string
  outcome: 'created' | 'existing' | 'updated' | 'unchanged'
  card?: MemoryCard
  note?: MemoryNote
  bindings: MemoryCardWorkBinding[]
  claims: MemoryCardWorkClaim[]
  boardRevision: number
}
export type MemoryCommandRead =
  | { commandId: string; state: 'known'; receipt: MemoryReceipt }
  | { commandId: string; state: 'rejected'; error: { code: string; message: string; status: number; details?: Record<string, unknown> } }
  | { commandId: string; state: 'unknown' }
export interface MemoryChangesPage extends MemoryPage<MemoryChange> {
  watermark: number
  resetRequired: boolean
}
export interface CardFilter {
  status: CardStatus
  completionKind?: 'completed' | 'dropped'
  query?: string
}
export interface PageOptions { cursor?: string; limit?: number; signal?: AbortSignal }
export type MemoryConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'unavailable'
export interface MemoryStreamListeners {
  ready(): void
  change(change: MemoryChange): void
  reset(): void
  connection(state: MemoryConnection): void
}
export interface MemoryBoardClient {
  resolve(scope: MemoryBoardScope, signal?: AbortSignal): Promise<MemoryBoard>
  readBoard(boardId: string, signal?: AbortSignal): Promise<MemoryBoardView>
  readCards(boardId: string, filter: CardFilter, options?: PageOptions): Promise<MemoryPage<MemoryCard>>
  readCard(boardId: string, cardId: string, options?: PageOptions): Promise<MemoryCardDetail>
  readBindings(boardId: string, cardId: string, options?: PageOptions): Promise<MemoryPage<MemoryCardWorkBinding>>
  readClaims(boardId: string, cardId: string, options?: PageOptions): Promise<MemoryPage<MemoryCardWorkClaim>>
  readNotes(boardId: string, archived: boolean, options?: PageOptions): Promise<MemoryPage<MemoryNote>>
  readCommand(boardId: string, commandId: string, signal?: AbortSignal): Promise<MemoryCommandRead>
  readChanges(boardId: string, afterSequence?: number, options?: PageOptions): Promise<MemoryChangesPage>
  mutate(command: MemoryBoardMutation): Promise<MemoryReceipt>
  subscribe(boardId: string, listeners: MemoryStreamListeners): () => void
}
export interface MemoryWireSchemas {
  bindings: z.ZodType<MemoryPage<MemoryCardWorkBinding>>
  claims: z.ZodType<MemoryPage<MemoryCardWorkClaim>>
  board: z.ZodType<MemoryBoardView>
  cards: z.ZodType<MemoryPage<MemoryCard>>
  card: z.ZodType<MemoryCardDetail>
  notes: z.ZodType<MemoryPage<MemoryNote>>
  command: z.ZodType<MemoryCommandRead>
  receipt: z.ZodType<MemoryReceipt>
  changes: z.ZodType<MemoryChangesPage>
  change: z.ZodType<MemoryChange>
}
/** A bounded, already-authorized node/work projection supplied by D's shell. */
export interface MemoryNodeOption {
  node: AgentNodeRef
  label: string
  available: boolean
  currentWork: Array<{ work: LogicalWorkRef; label: string }>
}
export interface MemoryWorkHealth {
  bindingId: string
  state: 'online' | 'offline' | 'stale'
  lastSeenAt?: string
  continuing?: boolean
  stopping?: boolean
}
export interface MemoryFilters {
  query: string
  status?: CardStatus
  doneOpen: boolean
  completionKind?: 'completed' | 'dropped'
}
