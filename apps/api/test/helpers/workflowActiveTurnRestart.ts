import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { startWhenReady, runningTurn, completedRun }
  from './harnessInstallationUpdate.js'
import { remoteReviewProduction, waitForRemoteReview } from './remoteReviewProduction.js'
import { expectMcpAccessDenied } from './deniedMcpTool.js'

// Started Runs use the coordination result protocol, so the fake Agent's final answer must be its JSON envelope.
export const completedEnvelopeText = JSON.stringify({
  data: 'Completed work', summary: 'Completed work.', board: { kind: 'none', reason: 'no_access' },
})

export async function answerWithCompletedEnvelope(fixture: { provider: { directory: string } }): Promise<void> {
  await writeFile(join(fixture.provider.directory, 'workflow-answers.json'), JSON.stringify([completedEnvelopeText]))
}

export async function assertActiveTurnRestart(options: {
  executionHost: 'main' | 'worker'
  mode: 'graceful' | 'crash'
  completion: 'after reconnect' | 'while API is down'
}): Promise<void> {
  const { executionHost, mode, completion } = options
  const fixture = await remoteReviewProduction({ workflow: 'single', executionHost,
    installationRefreshIntervalMs: 60_000, parallelSetup: true, parallelProfileChecks: true,
    includeNodeRuntimePayload: false })
  let blocked = false
  try {
    await answerWithCompletedEnvelope(fixture)
    await fixture.provider.blockWorkflowTurns()
    blocked = true
    const started = (await startWhenReady(fixture))!
    const original = await runningTurn(fixture)
    const before = await waitForRemoteReview(() => fixture.executions(started.run.id), executions =>
      executions.some(execution => execution.nativeSessionId === original.sessionId && execution.state === 'running'),
    'persisted active execution')
    expect(before).toHaveLength(1)
    const execution = before[0]!
    // Session binding precedes turn admission; restart only after Main has accepted the native turn.
    await waitForRemoteReview(() => fixture.details(started.run.id), details =>
      details.activity.some(activity => activity.harnessExecutionId === execution.id
        && activity.payload.nativeEventType === 'turn.started'), 'persisted native turn admission')
    const reader = await fixture.access.issue({ name: 'Restart readback reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
        scope: { workspaceIds: [started.run.workspaceId], workflowIds: [started.run.workflowId] } }] })
    const workerPid = fixture.workerPid()
    await fixture.restartMain({ mode, afterShutdown: async () => {
      const preserved = (await fixture.executions(started.run.id))[0]!
      expect(preserved.id).toBe(execution.id)
      expect(preserved.attempt).toBe(execution.attempt)
      expect(preserved.state).toBe('running')
      expect(preserved.nativeSessionId).toBe(original.sessionId)
      expect(preserved.result).toBeUndefined()
      expect(() => process.kill(original.pid, 0)).not.toThrow()
      if (completion === 'while API is down') {
        await fixture.provider.releaseWorkflowTurns()
        blocked = false
        await waitForRemoteReview(() => fixture.provider.calls(), calls => calls.some(call => {
          const result = call.workflowCompleted as typeof original | undefined
          return result?.pid === original.pid && result.turnId === original.turnId
        }), 'original provider completing during API downtime')
      }
    } })
    expect(fixture.workerPid()).toBe(workerPid)
    await expectMcpAccessDenied(fixture.call('run_stop', { workspaceId: started.run.workspaceId,
      runId: started.run.id, commandId: randomUUID() }, reader.token))
    if (blocked) {
      // Readback while the turn is active also exercises authenticated MCP recovery.
      const active = SavedRunDetailsSchema.parse(decodeMcpToolResult(await fixture.call('run_get', {
        detail: 'full', workspaceId: started.run.workspaceId, runId: started.run.id,
      }, reader.token)))
      expect(active.executions.map(item => item.id)).toEqual([execution.id])
      await fixture.provider.releaseWorkflowTurns()
      blocked = false
    }
    const finished = await completedRun(fixture, started.run.id)
    expect(finished.executions).toHaveLength(1)
    expect(finished.executions[0]).toMatchObject({ id: execution.id, attempt: execution.attempt,
      nativeSessionId: original.sessionId, state: 'completed',
      result: { outcome: 'succeeded', output: { text: completedEnvelopeText } } })
    const readback = SavedRunDetailsSchema.parse(decodeMcpToolResult(await fixture.call('run_get', {
      detail: 'full', workspaceId: started.run.workspaceId, runId: started.run.id,
    }, reader.token)))
    expect(readback.executions[0]!.result).toEqual(finished.executions[0]!.result)
    const calls = await fixture.provider.calls()
    expect(calls.filter(call => call.method === 'turn/start'
      && call.correlationId === `execution:${execution.id}`)).toHaveLength(1)
    expect(calls.filter(call => {
      const result = call.workflowCompleted as typeof original | undefined
      return result?.sessionId === original.sessionId
    })).toEqual([{ workflowCompleted: original }])
    expect(calls.some(call => call.method === 'turn/interrupt' && call.threadId === original.sessionId)).toBe(false)
  } finally {
    if (blocked) await fixture.provider.releaseWorkflowTurns()
    await fixture.close()
  }
}
