import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { remoteReviewProduction, waitForRemoteReview } from './remoteReviewProduction.js'
import { completedRun, startWhenReady } from './harnessInstallationUpdate.js'
import { expectMcpAccessDenied } from './deniedMcpTool.js'
import { readWorkflowClosure } from '../../src/modules/interactions/workflowClosure.js'

export async function assertWorkerOutputSettlement(cut: 'pending' | 'retired' = 'pending'): Promise<void> {
  const f = await remoteReviewProduction({ workflow: 'single', executionHost: 'worker',
    parallelSetup: true, parallelProfileChecks: true, includeNodeRuntimePayload: false })
  const failures: unknown[] = []
  try {
    await writeFile(join(f.provider.directory, 'workflow-answers.json'), JSON.stringify([JSON.stringify({
      data: 'Completed work', summary: 'Completed work.', board: { kind: 'none', reason: 'no_access' },
    })]))
    const interrupted = cut === 'pending' ? f.dropNextSettlement() : f.holdNextRetirementReply()
    let reached = false
    void interrupted.then(() => { reached = true })
    const started = (await startWhenReady(f))!
    await waitForRemoteReview(async () => reached, value => value, `Worker ${cut} settlement interruption`)
    const reply = await interrupted
    if (cut === 'retired') expect(reply).toMatchObject({ status: 'retired' })
    const before = await f.details(started.run.id)
    expect(before.executions).toHaveLength(1)
    expect(before.executions[0]).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
    const startup = await f.workerWorkflowStartup()
    if (cut === 'pending') {
      expect(startup).toContainEqual(expect.objectContaining({
        executionId: before.executions[0]!.id, terminal: undefined, stopFence: false,
      }))
    } else {
      expect(startup.some(item => item.executionId === before.executions[0]!.id)).toBe(false)
      const closure = await f.db.pool.query<{ closed: boolean }>(
        `select closed_at is not null as closed from execution_native_closures
          where execution_id=$1 order by generation desc limit 1`,
        [before.executions[0]!.id])
      expect(closure.rows).toEqual([{ closed: false }])
    }
    const reader = await f.access.issue({ name: 'Output recovery reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: [started.run.workspaceId] } }] })
    await expectMcpAccessDenied(f.call('run_stop', { workspaceId: started.run.workspaceId, runId: started.run.id }, reader.token))
    await f.restartMain({ mode: 'crash', afterShutdown: async () => { f.resumeWorkerConnection() } })
    const finished = await completedRun(f, started.run.id)
    expect(finished.executions).toHaveLength(1)
    const execution = finished.executions[0]!
    expect(execution).toMatchObject({ state: 'completed', attempt: 1, result: { outcome: 'succeeded' } })
    expect(execution.id).toBe(before.executions[0]!.id)
    expect(execution.nativeSessionId).toBe(before.executions[0]!.nativeSessionId)
    expect(execution.result).toEqual(before.executions[0]!.result)
    expect(await readWorkflowClosure(f.db.pool, execution)).toMatchObject({
      session: { nativeSessionId: execution.nativeSessionId },
    })
    await f.reconcile()
    expect((await f.details(started.run.id)).run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    expect(await readWorkflowClosure(f.db.pool, execution)).toMatchObject({
      session: { nativeSessionId: execution.nativeSessionId },
    })
    const calls = await f.provider.calls()
    expect(calls.filter(call => call.method === 'turn/start'
      && call.correlationId === `execution:${execution.id}`)).toHaveLength(1)
    expect(calls.some(call => call.method === 'turn/interrupt' && call.threadId === execution.nativeSessionId)).toBe(false)
    const receipts = await f.db.pool.query<{ receipt: unknown }>(`select receipt from remote_execution_receipts
      where receipt#>>'{intent,executionId}'=$1`, [execution.id])
    expect(receipts.rows).toHaveLength(1)
    expect(RemoteOperationReceiptSchema.parse(receipts.rows[0]!.receipt)).toMatchObject({
      outputValidationComplete: true, terminal: { kind: 'completed' }, native: { sessionId: execution.nativeSessionId },
    })
  } catch (error) {
    failures.push(error)
    console.error('Worker output settlement failed', error)
    console.error('Worker output failure details', JSON.stringify(f.failures()))
  }
  f.resumeWorkerConnection()
  try { await f.close() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Worker settlement and cleanup failed.')
}
