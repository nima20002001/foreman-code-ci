import { z } from 'zod'
import type { CompactionState, ContextSnapshot, SessionMode } from '@foreman-code/contracts'

export function codexCollaborationMode(mode: SessionMode, model: string, effort: string) {
  return { mode: mode === 'plan' ? 'plan' : 'default',
    settings: { model, reasoning_effort: effort, developer_instructions: null } }
}

const UsageSchema = z.object({
  threadId: z.string(),
  tokenUsage: z.object({
    last: z.object({ totalTokens: z.number().nonnegative() }),
    total: z.object({ totalTokens: z.number().nonnegative() }),
    modelContextWindow: z.number().positive().nullable(),
  }),
})

export function codexContextSnapshot(value: unknown, sessionId: string, model: string, sequence: number): ContextSnapshot | null {
  const parsed = UsageSchema.safeParse(value)
  if (!parsed.success || parsed.data.threadId !== sessionId) return null
  return { nativeSessionId: sessionId, model, sequence, observedAt: new Date().toISOString(), source: 'codex',
    generation: 'native', accuracy: 'native', usedTokens: parsed.data.tokenUsage.last.totalTokens,
    capacityTokens: parsed.data.tokenUsage.modelContextWindow,
    lifetimeTokens: parsed.data.tokenUsage.total.totalTokens, cost: null, stale: false }
}

export function codexCompactionNotification(state: CompactionState, method: string,
  params: Record<string, unknown>): CompactionState {
  if (params.threadId !== state.nativeSessionId) return state
  const turn = params.turn as { id?: string; status?: string; items?: { type?: string }[] } | undefined
  if (method === 'turn/started' && turn?.id && turn.id !== state.baselineTurnId && state.nativeOperationId === null) {
    return { ...state, nativeOperationId: turn.id, status: 'running', message: 'Compacting context.' }
  }
  const item = params.item as { type?: string } | undefined
  if (method === 'item/completed' && params.turnId === state.nativeOperationId && item?.type === 'contextCompaction') {
    return { ...state, message: 'Native compaction finished; waiting for its turn to close.' }
  }
  if (method !== 'turn/completed' || !turn || turn.id !== state.nativeOperationId) return state
  if (turn.status === 'failed' || turn.status === 'interrupted') {
    return { ...state, status: 'failed', message: 'Native compaction did not finish.' }
  }
  if (turn.status !== 'completed') return state
  const compacted = turn.items?.some(entry => entry.type === 'contextCompaction')
    || state.message === 'Native compaction finished; waiting for its turn to close.'
  return { ...state, status: compacted ? 'completed' : 'no-op',
    message: compacted ? 'Context compacted.' : 'The native session had nothing to compact.',
    observedAt: new Date().toISOString() }
}
