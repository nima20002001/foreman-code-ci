import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import { startWhenReady } from './helpers/harnessInstallationUpdate.js'
import { readUntil } from './helpers/observableCondition.js'
import { remoteReviewProduction } from './helpers/remoteReviewProduction.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const tickIndex = (execution: HarnessExecution) => (execution.input as { tick?: { index: number } }).tick?.index
const lastTick = (executions: HarnessExecution[]) => Math.max(0, ...executions.map(execution => tickIndex(execution) ?? 0))

describe.runIf(postgresEnabled)('loop Run after its database owner disconnects', () => {
  it('reattaches the running Agent and loop check and keeps scheduling checks, also after an API restart', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'interval', executionHost: 'main',
      installationRefreshIntervalMs: 60_000, parallelSetup: true, parallelProfileChecks: true,
      reuseMatchingProfiles: true, includeNodeRuntimePayload: false })
    try {
      await fixture.provider.blockWorkflowTurns({ allowFirst: 1 })
      const started = (await startWhenReady(fixture))!
      const read = () => fixture.details(started.run.id)
      // The test Main reconciles only on request; production reconciles every few seconds.
      const reconcileAndRead = async () => {
        await fixture.reconcile()
        return read()
      }
      const before = await readUntil(read, details => {
        const active = details.executions.filter(execution => execution.state === 'running')
        return active.length === 2 && active.every(execution => execution.nativeSessionId
          && details.activity.some(activity => activity.harnessExecutionId === execution.id
            && activity.payload.nativeEventType === 'turn.started'))
      }, { timeoutMs: 180_000, description: 'graph work and the first loop check', minimumReadIntervalMs: 1_000 })
      const check = before.executions.find(execution => tickIndex(execution) === 1)!
      const worker = before.executions.find(execution => execution.state === 'running' && execution.id !== check.id)!
      expect(check).toBeDefined()
      expect(worker).toBeDefined()

      // The database session holding the Run lock disconnects while the API keeps running.
      const owners = () => fixture.db.pool.query<{ pid: number }>(`select pid from pg_stat_activity
        where application_name='graphql-run-owner' and datname=current_database()`).then(result => result.rows.map(row => row.pid))
      const lost = await owners()
      expect(lost.length).toBeGreaterThan(0)
      const terminated = await fixture.db.pool.query<{ stopped: boolean }>(
        'select pg_terminate_backend(pid) as stopped from unnest($1::int[]) as owners(pid)', [lost])
      expect(terminated.rows.every(row => row.stopped)).toBe(true)
      // Reconciliation gives the Run a new owner while both original turns are still active.
      await readUntil(async () => {
        await fixture.reconcile()
        return owners()
      }, current => current.some(pid => !lost.includes(pid)),
      { timeoutMs: 60_000, description: 'a new Run owner', minimumReadIntervalMs: 500 })
      expect((await read()).run.executionState).toBe('running')
      await fixture.provider.releaseWorkflowTurns()

      // Both original attempts finish on their reattached sessions, then the loop keeps checking.
      const resumed = await readUntil(reconcileAndRead, details => {
        expect(details.run.executionState, JSON.stringify(details.run.result)).toBe('running')
        const finishedAt = details.executions.find(execution => execution.id === worker.id)?.finishedAt
        return finishedAt !== undefined && details.executions.some(execution => tickIndex(execution) !== undefined
          && execution.createdAt > finishedAt && execution.state === 'completed')
      }, { timeoutMs: 120_000, description: 'a loop check after the graph work finished', minimumReadIntervalMs: 1_000 })
      for (const original of [worker, check]) {
        expect(resumed.executions.find(execution => execution.id === original.id)).toMatchObject({
          state: 'completed', attempt: original.attempt, nativeSessionId: original.nativeSessionId,
          result: { outcome: 'succeeded' },
        })
      }
      const calls = await fixture.provider.calls()
      for (const original of [worker, check]) {
        expect(calls.filter(call => call.method === 'turn/start' && call.correlationId === `execution:${original.id}`))
          .toHaveLength(1)
      }

      // A deploy restarts the API while a later loop check is mid-turn; the loop resumes afterwards.
      const turnsSoFar = (await fixture.provider.calls()).filter(call => call.workflowTurn).length
      await fixture.provider.blockWorkflowTurns({ allowFirst: turnsSoFar })
      const blockedAt = new Date().toISOString()
      const blocked = await readUntil(reconcileAndRead, details => details.executions.some(execution =>
        tickIndex(execution) !== undefined && execution.createdAt > blockedAt && execution.state === 'running'
          && details.activity.some(activity => activity.harnessExecutionId === execution.id
            && activity.payload.nativeEventType === 'turn.started')),
      { timeoutMs: 120_000, description: 'a loop check blocked in its turn', minimumReadIntervalMs: 1_000 })
      const restartedFrom = lastTick(blocked.executions)
      await fixture.restartMain({ mode: 'graceful' })
      await fixture.provider.releaseWorkflowTurns()
      await readUntil(reconcileAndRead, details => {
        expect(details.run.executionState, JSON.stringify(details.run.result)).toBe('running')
        return details.executions.some(execution => (tickIndex(execution) ?? 0) > restartedFrom
          && execution.state === 'completed')
      }, { timeoutMs: 120_000, description: 'a loop check after the API restart', minimumReadIntervalMs: 1_000 })

      // Only Stop ends the loop Run.
      const stop = await fixture.call('run_stop', { workspaceId: started.run.workspaceId,
        runId: started.run.id, commandId: randomUUID() })
      expect(stop.isError).not.toBe(true)
      const stopped = await readUntil(read, details => details.run.executionState === 'completed',
        { timeoutMs: 60_000, description: 'the stopped loop Run', minimumReadIntervalMs: 1_000 })
      expect(stopped.run.outcome).toBe('canceled')
    } finally {
      await fixture.provider.releaseWorkflowTurns()
      await fixture.close()
    }
  }, 420_000)
})
