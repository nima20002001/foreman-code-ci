import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { RUN_INSPECTION_TOOLS, RunRecordDetailSchema } from '@foreman-code/contracts/wave25'
import { scenarioFixture } from './helpers/eng07BScenarios.js'
import { runPath, scenarioHarness } from './helpers/eng07BHarness.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { DomainError } from '../src/modules/errors.js'

describe.skipIf(!postgresEnabled)('routing workflow cleanup', () => {
  it.each(['immediate', 'deferred'] as const)('retries cleanup after %s closure without native replay', async closure => {
    const scenario = scenarioFixture('S3-03', randomUUID())
    const f = await scenarioHarness(scenario)
    const finishCleanup = f.base.runs.finishCleanup.bind(f.base.runs)
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    let recordAtTimeout: ReturnType<typeof RunRecordDetailSchema.parse> | undefined
    const cleanup = vi.spyOn(f.base.runs, 'finishCleanup')
      .mockImplementationOnce(async (runId) => {
        recordAtTimeout = RunRecordDetailSchema.parse(await f.http('GET', `${runPath({
          workspaceId: f.base.f.scope.workspaceId,
          runId,
        })}/record`))
        throw timeout
      })
      .mockImplementation(finishCleanup)
    const closeReviewers = f.base.native.finishIdleReviewers.bind(f.base.native)
    const reviewers = vi.spyOn(f.base.native, 'finishIdleReviewers').mockImplementation(closeReviewers)
    if (closure === 'deferred') {
      const pending = new DomainError('REPEAT_CLEANUP_PENDING', 'Native closure is still pending.', 409)
      reviewers.mockRejectedValueOnce(pending).mockRejectedValueOnce(pending).mockRejectedValueOnce(pending)
    }
    let recovery: Promise<void> | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      const { saved } = await f.save('mcp')
      const started = await f.start('mcp', saved)
      // The server retries yielded Runs on its reconciliation interval. This fixture owns only this Run.
      const recover = () => {
        recovery ??= (async () => {
          const snapshot = await f.base.runs.getRepeatSnapshot(started.scope.runId)
          if (snapshot.run.executionState === 'completed' && !snapshot.cleanupPending) return
          await f.base.engine.start(started.scope.runId)
        })().catch(error => { f.base.dispatchErrors.push(error) })
          .finally(() => { recovery = undefined })
      }
      recover()
      timer = setInterval(recover, 5_000)
      // Workflow execution and its database work precede the cleanup retry deadline.
      await vi.waitFor(async () => {
        const completed = RunRecordDetailSchema.parse(await f.http('GET', `${runPath(started.scope)}/record`))
        expect(completed.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      }, { timeout: 75_000, interval: 100 })
      const record = await f.settled(started.scope)
      clearInterval(timer)
      await recovery
      expect(cleanup.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(recordAtTimeout).toMatchObject({
        run: { id: started.scope.runId, executionState: 'completed', outcome: 'succeeded' },
        cleanupPending: true,
        stopRequested: false,
      })
      for (const [runId, failed] of cleanup.mock.calls) {
        expect(runId).toBe(started.scope.runId)
        expect(failed).toBe(false)
      }
      expect(record).toMatchObject({
        run: { executionState: 'completed', outcome: 'succeeded' },
        cleanupPending: false,
        stopRequested: false,
      })
      expect(await f.readParity(`${runPath(started.scope)}/record`, RUN_INSPECTION_TOOLS.record, {
        workspaceId: started.scope.workspaceId,
        runId: started.scope.runId,
      })).toEqual(record)
      const reader = await f.base.access.issue({
        name: 'Run cleanup reader',
        audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['runs:read'], scope: { runIds: [started.scope.runId] } }],
      })
      const monitor = await f.connect(reader.token)
      const denied = await monitor.callTool({
        name: 'run_start',
        arguments: { ...started.input, commandId: randomUUID() },
      })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const monitorRecord = RunRecordDetailSchema.parse(await f.mcp(RUN_INSPECTION_TOOLS.record, {
        workspaceId: started.scope.workspaceId,
        runId: started.scope.runId,
      }, monitor))
      const expectedMonitorRecord = structuredClone(record)
      delete expectedMonitorRecord.run.executionLocation
      expect(monitorRecord).toEqual(expectedMonitorRecord)
      expect(monitorRecord.run).not.toHaveProperty('executionLocation')
      expect(record.run.executionLocation).toBeDefined()
      expect(await f.http('GET', `${runPath(started.scope)}/record`, undefined, reader.token))
        .toEqual(monitorRecord)
      expect(await f.readParity(`${runPath(started.scope)}/record`, RUN_INSPECTION_TOOLS.record, {
        workspaceId: started.scope.workspaceId,
        runId: started.scope.runId,
      })).toEqual(record)
      const expectedNodes = scenario.executedIndexes.map(index => scenario.nodes[index]!.id)
      expect([...f.base.provider.startedNodes].sort()).toEqual(expectedNodes.sort())
      expect(new Set(f.base.provider.startedExecutions).size).toBe(expectedNodes.length)
      expect(f.base.provider.counts.starts).toBe(expectedNodes.length)
      expect(f.base.dispatchErrors).toEqual([])
    } finally {
      clearInterval(timer)
      try {
        await f.close()
      } finally {
        await recovery
        reviewers.mockRestore()
        cleanup.mockRestore()
      }
    }
  }, 120_000)
})
