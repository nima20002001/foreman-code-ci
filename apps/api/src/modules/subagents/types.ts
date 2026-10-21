import type pg from 'pg'
import type { z } from 'zod'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { RunSubagentGetInputSchema } from '@foreman-code/contracts/subagents'
import type { RunSubagent, RunSubagentCommandReceipt, RunSubagentMessage, RunSubagentTool,
  SubagentCapabilities, SubagentNativeMode } from '@foreman-code/contracts/subagents'

export interface SubagentProjectionContext {
  workspaceId: string; workflowId: string; workflowVersionId: string; runId: string
  parentNodeId: string; parentAgentId: string; parentExecutionId: string; parentAttemptKey: string
  provider: RunSubagent['provider']; parentSessionId: string; profile: RunSubagent['profile']
}
export type SubagentChange =
  | { kind: 'discover'; childId: string; parentSessionId: string; nativeMode: SubagentNativeMode;
      status: RunSubagent['status']; name?: string; taskId?: string; spawnToolUseId?: string; turnId?: string; agentPath?: string }
  | { kind: 'status'; childId: string; status: RunSubagent['status']; turnId?: string; taskId?: string; activateTask?: boolean }
  | { kind: 'message'; childId: string; nativeMessageId: string; blockId?: string; role: 'user' | 'assistant'; text: string; final: boolean; parentToolUseId?: string; nativeTruncation?: RunSubagentMessage['truncation'] }
  | { kind: 'tool'; childId: string; nativeToolId: string; name?: string; status: RunSubagentTool['status']; input?: unknown; output?: unknown; error?: unknown; nativeMessageId?: string; parentToolUseId?: string; durationMs?: number }

/** Only an admitted computer-owned manager may supply this lease. Main must never borrow a remote session. */
export interface SubagentControlLease {
  generation: string; nativeTurnId: string | null
  capabilities?: Pick<SubagentCapabilities, 'sendInput' | 'interrupt' | 'executionResume' | 'inputTiming'>
  /** Supplied only by the admitted manager after verifying its current native contracts. */
  matches(child: RunSubagent): boolean
  assertCurrent(): void
  sendInput?(receipt: RunSubagentCommandReceipt, text: string): Promise<void>
  interrupt?(receipt: RunSubagentCommandReceipt): Promise<void>
  pendingInteraction?(): import('@foreman-code/contracts').PendingNativeInteraction | undefined
  respond?(receipt: RunSubagentCommandReceipt): Promise<void>
  /** Read exact native correlation, never retry a prompt after uncertain delivery. */
  reconcile?(receipt: RunSubagentCommandReceipt): Promise<'acknowledged' | 'rejected' | 'uncertain'>
}
export type SubagentControlResolver = (child: RunSubagent) => SubagentControlLease | undefined
export interface SubagentNativeHistoryPage {
  events: readonly HarnessNativeEvent[]
  nextCursor: string | null
  /** Complete only after verified ancestry and authoritative full child history, not an SSE window. */
  coverage: RunSubagent['coverage']
}
export type SubagentNativeHistoryReader = (child: RunSubagent, cursor?: string) => Promise<SubagentNativeHistoryPage>
export type SubagentStoredItem = RunSubagentMessage | RunSubagentTool

export type SubagentNativeRecoverySource = (executionId: string, session: import('@foreman-code/contracts').NativeSessionReference, cursor: string | undefined, signal: AbortSignal) => Promise<import('../harnesses/port.js').NativeSubagentHistoryPage>

export interface SubagentRecoveryFailure {
  workspaceId: string; runId: string; executionId?: string; code: string
}
export interface SubagentReadScope {
  sql: pg.PoolClient
  principal: ManagementPrincipal
  stopped: boolean
  workflowId: string
  workflowVersionId: string
  projectionLocked: boolean
}
/** The RunSubagentService surface used by command dispatch and recovery. */
export interface SubagentServicePort {
  readonly pool: pg.Pool
  readonly controls: SubagentControlResolver
  readonly nativeRecovery?: SubagentNativeRecoverySource | undefined
  reportRecoveryFailure(failure: SubagentRecoveryFailure): void
  scoped<T>(principal: ManagementPrincipal, input: { workspaceId: string; runId: string }, action: ManagementAction,
    work: (scope: SubagentReadScope) => Promise<T>, options?: { projectionLock?: 'if-available' }): Promise<T>
  child(scope: SubagentReadScope, input: z.infer<typeof RunSubagentGetInputSchema>): Promise<RunSubagent>
}
