import { expect, it, vi } from 'vitest'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { memoryExecution } from '../src/modules/collaboration/memoryExecution.js'
import { lockSelections } from '../src/modules/memory-boards/batch.js'
import { workKey } from '../src/modules/memory-boards/identity.js'
import { settleMemoryRunLocked } from '../src/modules/runs/memoryRunSettlement.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { deferred } from './helpers/deferred.js'
import { memoryWorkflow, workflowMemory } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled)('settles Stop alongside an in-flight work update without a lock-order deadlock', async () => {
  const fixture = memoryWorkflow('parallel')
  fixture.version.approval = { handler: 'user' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.run.approval = fixture.version.approval
  const runtime = await currentOperatorIntegration({ fixture, approvalNodeIds: [fixture.version.definition.nodes[2]!.id],
    outputFor: () => ({ routing: { kind: 'finish' }, data: { latestDeliverable: { text: 'Partial work' }, remainingFindings: [] } }),
  })
  const locked = deferred<number>(), resume = deferred()
  let updating: Promise<unknown> | undefined, stopping: Promise<unknown> | undefined
  try {
    const memory = await workflowMemory(runtime, 1)
    await runtime.engine.start(runtime.f.run.id)
    const detail = await memory.read()
    const executionId = (detail.bindings as Array<{ currentExecutionId: string }>)[0]!.currentExecutionId
    updating = withExclusiveGraphConnection(runtime.db.pool, connection => connection.transaction(async tx => {
      const saved = await memoryExecution(tx, executionId)
      // Hold the same work reservation used by card mutations, then let Stop enter.
      await lockSelections(tx, [], [workKey(saved.work)])
      locked.resolve((await tx.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
      await resume.promise
      return runtime.services.memoryBoards.applyLifecycleLocked(tx, { agent: saved.subject.agent,
        execution: saved.subject.execution, work: saved.work, phase: 'waiting_children', reason: null,
        outstandingRequestIds: [], sourceEventKey: 'concurrent-work-update' })
    }))
    const pid = await locked.promise
    stopping = withExclusiveGraphConnection(runtime.db.pool, connection => connection.transaction(tx =>
      settleMemoryRunLocked(tx, runtime.services.memoryBoards, runtime.f.run.id,
        { outcome: 'canceled', error: { code: 'RUN_STOPPED', message: 'Stopped by operator', retryable: false } })))
    // Observe actual contention, rather than depending on sleeps or query text.
    await vi.waitFor(async () => {
      const blocked = await runtime.db.pool.query('select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid])
      expect(blocked.rowCount).toBe(1)
    }, { timeout: 5000, interval: 25 })
    resume.resolve()
    const outcomes = await Promise.allSettled([updating, stopping])
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(await memory.read()).toMatchObject({ card: { status: 'blocked' }, bindings: [{ state: 'canceled' }] })
  } finally {
    resume.resolve()
    await Promise.allSettled([updating, stopping])
    await runtime.close()
  }
}, 60000)
