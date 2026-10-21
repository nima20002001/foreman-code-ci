import type { RunExecutionSummary } from '@foreman-code/contracts/wave25'

/** The Agent's own branch of the workspace repository, when its workspace has one. */
export function ExecutionBranch({ execution }: { execution: RunExecutionSummary }) {
  if (!('worktree' in execution) || !execution.worktree) return null
  return <p className="run-execution-branch" title={execution.worktree.repository}>
    Branch <code>{execution.worktree.branch}</code> · {execution.worktree.repository}</p>
}
