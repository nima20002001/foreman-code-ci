import { compactionBlocksSend, type CompactionState } from '@foreman-code/contracts'
import { readClaudeCompactionResult } from './compactionResults.js'
import { readClaudeCompactionHistory, recoveredClaudeCompaction, ClaudeCompactionHistoryUnavailableError } from './compactionHistory.js'

/** Observes the admitted native request without opening an SDK query or issuing credentials. */
export async function recoverPersistedClaudeCompaction(state: CompactionState): Promise<CompactionState> {
  if (!compactionBlocksSend(state)) return state
  if (!state.claudeSession || !state.nativeSessionId) return state
  const session = { ...state.claudeSession, nativeSessionId: state.nativeSessionId }
  if (state.nativeRequestId) {
    const result = await readClaudeCompactionResult(session, state.nativeRequestId)
    if (result) return { ...state, status: result.status, observedAt: result.observedAt,
      message: result.status === 'failed' ? 'Claude rejected compaction.' : 'Native compaction completed.' }
  }
  if (!state.claudeCursor) return state
  try {
    const history = await readClaudeCompactionHistory(session, state.claudeCursor)
    return recoveredClaudeCompaction(state, history.boundaries)
  } catch (error) {
    if (error instanceof ClaudeCompactionHistoryUnavailableError) return state
    throw error
  }
}
