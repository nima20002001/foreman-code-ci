import { setTimeout } from 'node:timers/promises'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

export const RUN_START_LOCK_WAIT_MS = 30_000

export interface RunStartLockWait {
  deadline: number
  signal?: AbortSignal
}

export async function waitForRunStartLock(sql: GraphSqlClient, key: string,
  wait: RunStartLockWait = { deadline: performance.now() + RUN_START_LOCK_WAIT_MS }): Promise<void> {
  for (;;) {
    wait.signal?.throwIfAborted()
    if (performance.now() >= wait.deadline) {
      throw new DomainError('RUN_START_BUSY',
        'Another Start or workspace change is still in progress. Retry the same Start command.', 409)
    }
    // Nonblocking probes keep both server and client SQL deadlines intact while Start queues.
    const result = await sql.query<{ locked: boolean }>(
      'select pg_try_advisory_xact_lock(hashtext($1)) as locked', [key])
    wait.signal?.throwIfAborted()
    if (result.rows[0]?.locked === true) return
    const remaining = wait.deadline - performance.now()
    try {
      await setTimeout(Math.max(0, Math.min(100, remaining)), undefined, { signal: wait.signal })
    } finally {
      wait.signal?.throwIfAborted()
    }
  }
}
