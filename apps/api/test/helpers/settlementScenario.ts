import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { RunRecordDetailSchema, RUN_INSPECTION_TOOLS } from '@foreman-code/contracts/wave25'
import { isSettlementPendingCheckpointError } from '../../src/modules/interactions/repeatNativeEvidence.js'
import { readWorkflowCheckpoint } from '../../src/modules/runs/repeatGraph.js'
import { scenarioFixture } from './eng07BScenarios.js'
import { runPath, scenarioHarness } from './eng07BHarness.js'
import { waitForSuccessfulRunCleanup } from './runSettlement.testSupport.js'

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

export async function assertCleanupWaitsForOriginalWriter(id: 'S3-01' | 'S3-05-early') {
  const f = await scenarioHarness(scenarioFixture(id, randomUUID()))
  const cleanupEntered = latch(), releaseCleanup = latch(), readOnce = latch()
  const finishCleanup = f.base.runs.finishCleanup.bind(f.base.runs)
  // completeRunLocked commits a pending intent WITH the terminal Run. Pause
  // before its successful cleanup check, not before a supposed intent insert.
  // The ORIGINAL writer retains the same owner, arguments and proof checks.
  const gate = vi.spyOn(f.base.runs, 'finishCleanup').mockImplementation(async (...args) => {
    cleanupEntered.release()
    await releaseCleanup.promise
    return finishCleanup(...args)
  })
  let pending: Promise<unknown> | undefined
  try {
    const { saved } = await f.save('http'), started = await f.start('http', saved)
    let entered = false
    void cleanupEntered.promise.then(() => { entered = true })
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 60000 })
    } catch (error) {
      const run = (await f.base.db.pool.query<{ state: string; outcome: string; cleanup: boolean }>(
        `select execution_state as state, record->>'outcome' as outcome,
          exists(select 1 from run_cleanup_intents where run_id=$1 and pending) as cleanup
         from runs where id=$1`, [started.scope.runId])).rows[0]
      const executions = (await f.base.db.pool.query<{ state: string; code: string | null;
        accepted: boolean; credentialsClosed: boolean }>(
        `select record->>'state' as state, record#>>'{result,error,code}' as code,
          accepted, worker_credentials_closed_at is not null as "credentialsClosed"
         from harness_executions where run_id=$1 order by id`, [started.scope.runId])).rows
      const progress = (await f.base.db.pool.query<{ occurrences: number; decisions: number;
        resolutions: number; completion: number; openCredentials: number }>(
        `select
          (select count(*)::int from run_repeat_occurrences where run_id=$1) as occurrences,
          (select count(*)::int from run_repeat_decisions d join run_repeat_occurrences o
            on o.occurrence_id=d.occurrence_id where o.run_id=$1) as decisions,
          (select count(*)::int from run_repeat_resolutions where run_id=$1) as resolutions,
          (select count(*)::int from run_repeat_effects where run_id=$1 and effect_kind='run.complete') as completion,
          (select count(*)::int from worker_credential_bindings where run_id=$1 and revoked_at is null) as "openCredentials"`,
        [started.scope.runId])).rows[0]
      const checkpoint = await readWorkflowCheckpoint(started.scope.runId, saved.version, f.base.checkpointer)
      throw new Error(`Original cleanup writer was not reached: ${JSON.stringify({ id, run, executions,
        progress, checkpoint: { next: checkpoint.next, tasks: checkpoint.tasks.map((task) => ({
          name: task.name, pendingSettlement: isSettlementPendingCheckpointError(task.error),
          interrupted: Boolean(task.interrupts?.length), errorName: task.error && typeof task.error === 'object'
            && 'name' in task.error ? String(task.error.name) : null,
        })) }, starts: f.base.provider.counts.starts, dispatchErrors: f.base.dispatchErrors })}`, { cause: error })
    }
    const read = async () => RunRecordDetailSchema.parse(await f.http('GET', `${runPath(started.scope)}/record`))
    const before = await read()
    expect(before).toMatchObject({ run: { executionState: 'completed', outcome: 'succeeded' },
      stopRequested: false, cleanupPending: true })
    expect((await f.base.db.pool.query('select pending,attempts from run_cleanup_intents where run_id=$1',
      [started.scope.runId])).rows).toEqual([{ pending: true, attempts: 0 }])
    const counts = { ...f.base.provider.counts }
    let returned = false
    pending = waitForSuccessfulRunCleanup({ pool: f.base.db.pool, runId: started.scope.runId,
      readRecord: async () => { const value = await read(); readOnce.release(); return value } })
      .then((value) => { returned = true; return value })
    void pending.catch(() => undefined) // The awaited promise below retains failure.
    await Promise.race([readOnce.promise, pending])
    // Drain promise reactions; the cleanup gate, not a wall-clock sleep, keeps
    // the real Run terminal with an unverified, still-pending cleanup intent.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(returned, 'A terminal Run with unchecked pending cleanup must not pass the barrier').toBe(false)
    releaseCleanup.release()
    const after = await pending
    expect(after).toEqual(await f.readParity(`${runPath(started.scope)}/record`, RUN_INSPECTION_TOOLS.record,
      { workspaceId: started.scope.workspaceId, runId: started.scope.runId }))
    const intent = (await f.base.db.pool.query<{ pending: boolean; attempts: number }>(
      'select pending,attempts from run_cleanup_intents where run_id=$1', [started.scope.runId])).rows[0]!
    expect(intent.pending).toBe(false)
    expect(intent.attempts).toBeGreaterThan(0)
    await f.settled(started.scope)
    expect(f.base.provider.counts).toEqual(counts)
    expect(f.base.dispatchErrors).toEqual([])
  } finally {
    releaseCleanup.release()
    await pending?.catch(() => undefined)
    gate.mockRestore()
    await f.close()
  }
}
