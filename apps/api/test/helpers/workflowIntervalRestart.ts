import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { startWhenReady } from './harnessInstallationUpdate.js'
import { expectMcpAccessDenied } from './deniedMcpTool.js'
import { remoteReviewProduction } from './remoteReviewProduction.js'
import { readUntil } from './observableCondition.js'

export async function assertIntervalRestart(executionHost: 'main' | 'worker'): Promise<void> {
  const fixture = await remoteReviewProduction({ workflow: 'interval', executionHost,
    installationRefreshIntervalMs: 60_000, parallelSetup: true, parallelProfileChecks: true,
    reuseMatchingProfiles: true, includeNodeRuntimePayload: false })
  let blocked = false
  try {
    await fixture.provider.blockWorkflowTurns({ allowFirst: 1 })
    blocked = true
    const started = (await startWhenReady(fixture))!
    const admittedIds = new Set<string>()
    const before = await readUntil(async () => {
      // This fixture has no server reconciliation timer to resume pending native settlement.
      await fixture.reconcile()
      const details = await fixture.details(started.run.id)
      const calls = await fixture.provider.calls()
      for (const execution of details.executions) {
        if (details.activity.some(activity => activity.harnessExecutionId === execution.id
          && activity.payload.nativeEventType === 'turn.started')) admittedIds.add(execution.id)
      }
      const active = details.executions.filter(execution => execution.state === 'running')
      const admitted = active.length === 2 && active.every(execution => execution.nativeSessionId
        && admittedIds.has(execution.id)
        && calls.some(call => {
          const turn = call.workflowTurn as { sessionId: string } | undefined
          return turn?.sessionId === execution.nativeSessionId
        }))
      return admitted ? details : undefined
    }, details => details !== undefined, {
      timeoutMs: 180_000, description: 'active graph work and interval check',
      minimumReadIntervalMs: 1_000,
      subscribe: fixture.subscribeNativeChanges,
    })
    if (!before) throw new Error('Expected both native turns to be admitted')
    expect(before.executions, JSON.stringify(before.executions.map(execution => ({
      id: execution.id, node: execution.workflowNodeId, state: execution.state,
      result: execution.result, nativeSessionId: execution.nativeSessionId,
    })))).toHaveLength(3)
    const active = before.executions.filter(execution => execution.state === 'running')
    expect(active.filter(({ input }) => input !== null && typeof input === 'object'
      && !Array.isArray(input) && input.tick)).toHaveLength(1)
    const calls = await fixture.provider.calls()
    const originals = active.map(execution => {
      const starts = calls.filter(call => call.method === 'turn/start'
        && call.correlationId === `execution:${execution.id}`)
      expect(starts).toHaveLength(1)
      const call = calls.find(item => {
        const turn = item.workflowTurn as { pid: number; sessionId: string } | undefined
        return turn !== undefined && turn.sessionId === execution.nativeSessionId && turn.pid === starts[0]!.pid
      })
      expect(call).toBeDefined()
      return call!.workflowTurn as { pid: number; sessionId: string; turnId: string }
    })
    const reader = await fixture.access.issue({ name: 'Interval restart reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
        scope: { workspaceIds: [started.run.workspaceId], workflowIds: [started.run.workflowId] } }] })
    const workerPid = fixture.workerPid()
    console.info('Interval restart admitted executions:', active.map(execution => ({
      id: execution.id, nativeSessionId: execution.nativeSessionId,
    })))
    await fixture.restartMain({ mode: 'graceful', afterShutdown: async () => {
      console.info('Interval restart Main shutdown completed')
      const preserved = await fixture.executions(started.run.id)
      for (const execution of active) {
        expect(preserved.find(item => item.id === execution.id)).toMatchObject({
          id: execution.id, attempt: execution.attempt, nativeSessionId: execution.nativeSessionId,
          state: 'running', input: execution.input,
        })
      }
      const cleanup = await fixture.db.pool.query<{ pending: boolean }>(
        'select pending from run_cleanup_intents where run_id=$1', [started.run.id])
      expect(cleanup.rows.some(row => row.pending)).toBe(false)
      for (const turn of originals) expect(() => process.kill(turn.pid, 0)).not.toThrow()
    } })
    expect(fixture.workerPid()).toBe(workerPid)
    await expectMcpAccessDenied(fixture.call('run_stop', { workspaceId: started.run.workspaceId,
      runId: started.run.id, commandId: randomUUID() }, reader.token))
    const recovered = SavedRunDetailsSchema.parse(decodeMcpToolResult(await fixture.call('run_get', {
      detail: 'full', workspaceId: started.run.workspaceId, runId: started.run.id,
    }, reader.token)))
    expect(recovered.run.executionState).toBe('running')
    for (const execution of active) {
      expect(recovered.executions.find(item => item.id === execution.id)).toMatchObject({
        state: 'running', attempt: execution.attempt, nativeSessionId: execution.nativeSessionId,
      })
    }
    await fixture.provider.releaseWorkflowTurns()
    blocked = false
    await readUntil(async () => {
      await fixture.reconcile()
      return fixture.details(started.run.id)
    }, details => details.executions.every(execution => execution.state === 'completed'),
      { timeoutMs: 60_000, description: 'settled graph work and interval check' })
    const stop = await fixture.call('run_stop', { workspaceId: started.run.workspaceId,
      runId: started.run.id, commandId: randomUUID() })
    expect(stop.isError).not.toBe(true)
    const finished = await readUntil(() => fixture.details(started.run.id),
      details => details.run.executionState === 'completed',
      { timeoutMs: 60_000, description: 'stopped interval Run' })
    expect(finished.run.outcome).toBe('canceled')
    expect(finished.executions.map(execution => execution.id).sort())
      .toEqual(before.executions.map(execution => execution.id).sort())
    for (const execution of active) {
      expect(finished.executions.find(item => item.id === execution.id)).toMatchObject({
        state: 'completed', attempt: execution.attempt, nativeSessionId: execution.nativeSessionId,
        result: { outcome: 'succeeded' },
      })
    }
    const readback = SavedRunDetailsSchema.parse(decodeMcpToolResult(await fixture.call('run_get', {
      detail: 'full', workspaceId: started.run.workspaceId, runId: started.run.id,
    }, reader.token)))
    expect(readback.executions.map(execution => execution.id).sort())
      .toEqual(finished.executions.map(execution => execution.id).sort())
    for (const execution of finished.executions) {
      expect(readback.executions.find(item => item.id === execution.id)?.result).toEqual(execution.result)
    }
    const after = await fixture.provider.calls()
    for (const execution of active) {
      expect(after.filter(call => call.method === 'turn/start'
        && call.correlationId === `execution:${execution.id}`)).toHaveLength(1)
      expect(after.some(call => call.method === 'turn/interrupt'
        && call.threadId === execution.nativeSessionId)).toBe(false)
    }
  } catch (error) {
    console.error(error)
    console.error('First native failures:', JSON.stringify(fixture.failures().slice(0, 16).map(failure => ({
      ...failure, errorLocation: typeof failure.errorLocation === 'string'
        ? failure.errorLocation.split(' (')[0] : failure.errorLocation,
    }))))
    throw error
  } finally {
    if (blocked) await fixture.provider.releaseWorkflowTurns()
    await fixture.close()
  }
}
