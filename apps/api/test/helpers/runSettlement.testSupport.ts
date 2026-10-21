import { setTimeout as delay } from 'node:timers/promises'
import type pg from 'pg'
import type { RunRecordDetail } from '@foreman-code/contracts/wave25'

/** Read-only barrier for successful fixture Runs, ordinary or repeated.
 * completeRunLocked commits the terminal Run WITH its pending cleanup intent.
 * Completion alone is not settlement: require the original writer's successful
 * check and matching public readback. Missing or unchecked evidence fails closed.
 * Never call Start, resume, reconcile, finishCleanup or manufacture a receipt. */
export async function waitForSuccessfulRunCleanup(input: {
  pool: Pick<pg.Pool, 'query'>
  runId: string
  readRecord(): Promise<RunRecordDetail>
  timeoutMs?: number
  intervalMs?: number
}): Promise<RunRecordDetail> {
  const timeout = input.timeoutMs ?? 25000, interval = input.intervalMs ?? 50
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval <= 0) {
    throw new RangeError('Settlement polling requires finite positive bounds')
  }
  const deadline = Date.now() + timeout
  for (;;) {
    const intent = (await input.pool.query<{ pending: boolean; attempts: number }>(
      'select pending,attempts from run_cleanup_intents where run_id=$1', [input.runId])).rows[0]
    // Read after the intent, not from a pre-cleanup cached record. Authentication,
    // schema and SQL errors propagate immediately instead of being retried away.
    const record = await input.readRecord()
    if (record.run.id !== input.runId) throw new Error('Settlement read returned a different Run')
    if (intent?.pending === false && intent.attempts > 0
      && record.run.executionState === 'completed' && record.run.outcome === 'succeeded'
      && record.stopRequested === false && record.cleanupPending === false) return record
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // No private input/result, directory, native transcript or credential data.
      throw new Error(`Run cleanup did not settle: ${JSON.stringify({ runId: input.runId,
        executionState: record.run.executionState, outcome: record.run.outcome,
        stopRequested: record.stopRequested, cleanupPending: record.cleanupPending,
        intentPresent: intent !== undefined, intentPending: intent?.pending ?? null,
        cleanupAttempts: intent?.attempts ?? null })}`)
    }
    await delay(Math.min(interval, remaining))
  }
}
