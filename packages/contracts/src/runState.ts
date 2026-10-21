import type { RunExecutionState, WorkflowRunSummary, GetRunResponse } from './index.js'

export function isLiveRunState(state: RunExecutionState | undefined): boolean {
  return state === 'queued' || state === 'running' || state === 'waiting'
}
export function requiresRunRecovery(run: Pick<WorkflowRunSummary, 'executionState' | 'cleanupPending'>): boolean {
  return run.executionState === 'interrupted' || run.cleanupPending === true
}
/** Poll lifecycle cleanup, not a stopped/interrupted Run without active cleanup. */
export function runRefetchInterval(details: (Pick<GetRunResponse, 'cleanupPending'> & { run: Pick<GetRunResponse['run'], 'executionState'> }) | undefined): 1000 | false {
  return !details || isLiveRunState(details.run.executionState) || details.cleanupPending === true ? 1000 : false
}
