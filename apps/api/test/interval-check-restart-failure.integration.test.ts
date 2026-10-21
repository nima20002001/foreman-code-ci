import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { startWhenReady } from './helpers/harnessInstallationUpdate.js'
import { readUntil } from './helpers/observableCondition.js'
import { remoteReviewProduction } from './helpers/remoteReviewProduction.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('interval check failure during API restart', () => {
  it('records the interrupted check and starts the next check while graph work stays running', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'interval', executionHost: 'main',
      installationRefreshIntervalMs: 60_000, parallelSetup: true, parallelProfileChecks: true,
      reuseMatchingProfiles: true, includeNodeRuntimePayload: false })
    try {
      await fixture.provider.blockWorkflowTurns({ allowFirst: 1 })
      const started = (await startWhenReady(fixture))!
      const read = async () => {
        await fixture.reconcile()
        return fixture.details(started.run.id)
      }
      const before = await readUntil(read, details => {
        const active = details.executions.filter(execution => execution.state === 'running')
        return active.length === 2 && active.every(execution => execution.nativeSessionId
          && details.activity.some(activity => activity.harnessExecutionId === execution.id
            && activity.payload.nativeEventType === 'turn.started'))
      }, { timeoutMs: 180_000, description: 'graph work and a loop check', minimumReadIntervalMs: 1_000 })
      const check = before.executions.find(execution =>
        execution.state === 'running' && (execution.input as { tick?: { index: number } }).tick)!
      const checkIndex = (check.input as { tick: { index: number } }).tick.index
      const worker = before.executions.find(execution =>
        execution.state === 'running' && execution.id !== check.id)!
      const turn = await readUntil(async () => (await fixture.provider.calls())
        .map(call => call.workflowTurn as { pid: number; sessionId: string } | undefined)
        .find(value => value?.sessionId === check.nativeSessionId), value => value !== undefined,
      { timeoutMs: 30_000, description: 'the interval provider process' })
      if (!turn) throw new Error('Expected the interval provider process')
      const reader = await fixture.access.issue({ name: 'Loop recovery reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
          scope: { workspaceIds: [started.run.workspaceId], workflowIds: [started.run.workflowId] } }] })
      const denied = await fixture.access.issue({ name: 'Other workspace reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
          scope: { workspaceIds: ['other-workspace'] } }] })
      await fixture.restartMain({ mode: 'graceful', afterShutdown: async () => {
        expect((await fixture.executions(started.run.id)).find(execution => execution.id === check.id))
          .toMatchObject({ state: 'running', nativeSessionId: check.nativeSessionId })
        process.kill(turn.pid, 'SIGKILL')
      } })
      const recovered = await readUntil(read, details => {
        expect(details.run.executionState, JSON.stringify(details.run.result)).toBe('running')
        expect(details.cleanupPending).toBe(false)
        return details.executions.some(execution => execution.state === 'running' && execution.nativeSessionId
          && (execution.input as { tick?: { index: number } }).tick?.index === checkIndex + 1)
      }, { timeoutMs: 90_000, description: 'the next check after native interruption', minimumReadIntervalMs: 1_000 })
      expect(recovered.cleanupPending).toBe(false)
      expect(recovered.executions.find(execution => execution.id === check.id)).toMatchObject({
        state: 'completed', result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED' } },
      })
      expect(recovered.executions.find(execution => execution.id === worker.id)).toMatchObject({
        state: 'running', nativeSessionId: worker.nativeSessionId, attempt: worker.attempt,
      })
      const args = { detail: 'full', workspaceId: started.run.workspaceId, runId: started.run.id }
      const response = await fixture.call('run_get', args, reader.token)
      expect(response.isError).not.toBe(true)
      const persisted = SavedRunDetailsSchema.parse(decodeMcpToolResult(response))
      expect(persisted.run).toMatchObject({ executionState: 'running', outcome: 'pending' })
      expect(persisted.executions.find(execution => execution.id === check.id)?.result)
        .toEqual(recovered.executions.find(execution => execution.id === check.id)?.result)
      await expectMcpAccessDenied(fixture.call('run_get', args, denied.token))
      const after = await fixture.provider.calls()
      expect(after.filter(call => call.method === 'turn/start' && call.correlationId === `execution:${check.id}`))
        .toHaveLength(1)
      await fixture.provider.releaseWorkflowTurns()
      await readUntil(read, details => details.executions.every(execution => execution.state === 'completed'),
        { timeoutMs: 60_000, description: 'settled interval executions' })
      expect((await read()).run.executionState).toBe('running')
      const stop = await fixture.call('run_stop', { workspaceId: started.run.workspaceId, runId: started.run.id })
      expect(stop.isError).not.toBe(true)
      const finished = await readUntil(read, details => details.run.executionState === 'completed',
        { timeoutMs: 60_000, description: 'stopped interval Run' })
      expect(finished.run.outcome).toBe('canceled')
      expect(finished.executions.find(execution => execution.id === check.id)).toMatchObject({
        state: 'completed', result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED' } },
      })
      expect(finished.executions.find(execution => execution.id === worker.id)).toMatchObject({
        state: 'completed', attempt: worker.attempt, nativeSessionId: worker.nativeSessionId,
        result: { outcome: 'succeeded' },
      })
      const stoppedReadback = SavedRunDetailsSchema.parse(decodeMcpToolResult(
        await fixture.call('run_get', args, reader.token)))
      expect(stoppedReadback.run).toMatchObject({ executionState: 'completed', outcome: 'canceled' })
      expect(stoppedReadback.executions.find(execution => execution.id === check.id)?.result)
        .toEqual(finished.executions.find(execution => execution.id === check.id)?.result)
    } finally {
      await fixture.provider.releaseWorkflowTurns()
      await fixture.close()
    }
  }, 300_000)
})
