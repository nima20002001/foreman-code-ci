import type { CiRunRecord } from '@foreman-code/contracts'

/** Tickets keep their ID across retries and reassignment; executors use a fresh ID for idempotent starts. */
export function ciExecutionRunId(run: CiRunRecord): string {
  return run.executionRunId ?? run.setupRetry?.runId ?? run.id
}
