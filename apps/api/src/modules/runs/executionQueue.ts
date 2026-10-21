import type { ExecutionQueueEntry, ExecutionQueueReason, HarnessExecution } from '@foreman-code/contracts'

export type ExecutionQueueIdentity = Pick<HarnessExecution, 'id' | 'runId' | 'workflowNodeId'>
type WaitReason = Omit<Extract<ExecutionQueueReason, { kind: 'host_capacity' }>, 'since'>
  | Omit<Extract<ExecutionQueueReason, { kind: 'workflow_parallelism' }>, 'since'>

// These waits belong to the process-local gates, not the immutable graph journal.
const waiting = new Map<string, { identity: ExecutionQueueIdentity; reason: ExecutionQueueReason }>()

export async function withExecutionQueueReason<T>(identity: ExecutionQueueIdentity | undefined,
  reason: WaitReason, work: () => Promise<T>): Promise<T> {
  if (!identity) return work()
  const wait = { identity, reason: { ...reason, since: new Date().toISOString() } }
  waiting.set(identity.id, wait)
  try {
    return await work()
  } finally {
    if (waiting.get(identity.id) === wait) waiting.delete(identity.id)
  }
}

export function readExecutionQueueReason(execution: HarnessExecution): ExecutionQueueReason | undefined {
  const wait = waiting.get(execution.id)
  if (!wait || execution.state === 'completed' || wait.identity.runId !== execution.runId) return undefined
  return wait.reason
}

export function readRunExecutionQueue(runId: string): ExecutionQueueEntry[] {
  const entries: ExecutionQueueEntry[] = []
  for (const { identity, reason } of waiting.values()) {
    if (identity.runId === runId) entries.push({
      executionId: identity.id,
      workflowNodeId: identity.workflowNodeId,
      reason,
    })
  }
  return entries
}
