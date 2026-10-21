import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { installationUpdateFixture, startWhenReady } from './harnessInstallationUpdate.js'
import { readUntil } from './observableCondition.js'
import { expectMcpAccessDenied } from './deniedMcpTool.js'
import { repeatTickIndex } from '../../src/modules/runs/repeatResolution.js'

type RestartPhase = 'active' | 'writable source' | 'admitting interval' | 'failed admission'

export async function assertInstalledWorkflowRestart(phase: RestartPhase,
  installedFixture?: Awaited<ReturnType<typeof installationUpdateFixture>>) {
  const activePhase = phase === 'active' || phase === 'writable source'
  const fixture = installedFixture ?? await installationUpdateFixture({ workflow: 'interval', executionHost: 'main',
    installedMainService: true,
    sourceAccessMode: phase === 'writable source' ? 'exclusive-write' : 'read-only' })
  const service = fixture.mainService!
  let restart: ReturnType<typeof service.restart> | undefined
  try {
    await fixture.provider.blockWorkflowTurns({ allowFirst: 1 })
    if (!activePhase) await fixture.provider.blockWorkflowAdmission()
    const started = (await startWhenReady(fixture))!
    const before = await readUntil(async () => {
      const details = await fixture.details(started.run.id)
      const calls = await fixture.provider.calls()
      const active = details.executions.filter(item => item.state === 'running' && item.nativeSessionId)
      const blocked = calls.some(call => call.workflowAdmissionBlocked)
      const turns = calls.filter(call => call.workflowTurn)
      return active.length === 2 && (activePhase ? turns.length === 3 : blocked) ? details : undefined
    }, value => value !== undefined, { timeoutMs: 180_000, description: 'graph work and interval session' })
    if (!before) throw new Error('Expected two saved active native sessions.')
    const active = before.executions.filter(item => item.state === 'running')
    const nativeEventCounts = async () => {
      const rows = await fixture.db.pool.query<{ execution_id: string; total: number }>(
        `select execution_id,count(*)::integer as total from harness_native_events
         where execution_id=any($1::text[]) group by execution_id`, [active.map(item => item.id)])
      return new Map(rows.rows.map(row => [row.execution_id, row.total]))
    }
    const previousEvents = await nativeEventCounts()
    const launches = service.registry.snapshot().launches.filter(launch =>
      active.some(item => launch.owner === `execution:${item.id}`) && launch.lifecycle !== 'closed')
    expect(launches).toHaveLength(2)
    if (phase === 'writable source') {
      expect(active.filter(item => repeatTickIndex(item.input) === 1)).toHaveLength(1)
      for (const original of active) {
        expect(await readFile(join(original.workingDirectory!, 'README.md'), 'utf8')).toBe('# Native workflow edit\n')
      }
    }
    const previousPid = await service.pid()
    const reader = await fixture.access.issue({ name: 'Installed restart reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
        scope: { workspaceIds: [started.run.workspaceId], workflowIds: [started.run.workflowId] } }] })
    restart = service.restart()
    if (!activePhase) {
      await readUntil(service.state, value => value === 'deactivating',
      { timeoutMs: 10_000, description: 'systemd beginning API restart' })
      await service.waitForPreservation()
      if (phase === 'failed admission') await fixture.provider.failWorkflowAdmission()
      await fixture.provider.releaseWorkflowAdmission()
    }
    const ready = (await restart)!
    expect(ready.pid).not.toBe(previousPid)
    await fixture.reconcile()
    await expectMcpAccessDenied(fixture.call('run_stop', { workspaceId: started.run.workspaceId,
      runId: started.run.id, commandId: randomUUID() }, reader.token))
    const recovered = SavedRunDetailsSchema.parse(decodeMcpToolResult(await fixture.call('run_get', {
      detail: 'full', workspaceId: started.run.workspaceId, runId: started.run.id,
    }, reader.token)))
    if (phase !== 'failed admission') {
      expect(recovered.run.executionState).toBe('running')
      for (const original of active) {
        expect(recovered.executions.find(item => item.id === original.id)).toMatchObject({
          state: 'running', attempt: original.attempt, nativeSessionId: original.nativeSessionId,
        })
      }
      if (phase === 'writable source') {
        for (const original of launches) {
          expect(service.registry.snapshot().launches.find(item => item.launchId === original.launchId)?.provider)
            .toEqual(original.provider)
          if (original.provider) expect(() => process.kill(original.provider!.pid, 0)).not.toThrow()
        }
        await readUntil(nativeEventCounts, counts => active.every(original =>
          (counts.get(original.id) ?? 0) > (previousEvents.get(original.id) ?? 0)),
        { timeoutMs: 30_000, description: 'native events from both adopted sessions' })
      }
    } else {
      const interrupted = await readUntil(async () => {
        await fixture.reconcile()
        return fixture.details(started.run.id)
      }, details => details.executions.some(execution => repeatTickIndex(execution.input) === 1
        && execution.state === 'completed'),
      { timeoutMs: 90_000, description: 'failed interval admission settlement' })
      expect(interrupted.run.executionState).toBe('running')
      expect(interrupted.cleanupPending).toBe(false)
      for (const original of active.filter(execution => repeatTickIndex(execution.input) === undefined)) {
        expect(interrupted.executions.find(execution => execution.id === original.id)).toMatchObject({
          state: 'running', attempt: original.attempt, nativeSessionId: original.nativeSessionId,
        })
      }
    }
    await fixture.provider.releaseWorkflowTurns()
    await readUntil(() => fixture.details(started.run.id),
      details => details.executions.every(execution => execution.state === 'completed'),
      { timeoutMs: 90_000, description: 'settled graph work and interval check' })
    const stop = await fixture.call('run_stop', { workspaceId: started.run.workspaceId,
      runId: started.run.id, commandId: randomUUID() })
    expect(stop.isError).not.toBe(true)
    const finished = await readUntil(() => fixture.details(started.run.id),
      details => details.run.executionState === 'completed',
      { timeoutMs: 90_000, description: 'stopped interval Run' })
    expect(finished.run.outcome).toBe('canceled')
    const persisted = SavedRunDetailsSchema.parse(decodeMcpToolResult(await fixture.call('run_get', {
      detail: 'full', workspaceId: started.run.workspaceId, runId: started.run.id,
    }, reader.token)))
    expect(persisted.run).toMatchObject({ id: finished.run.id, executionState: 'completed',
      outcome: finished.run.outcome, result: finished.run.result, finishedAt: finished.run.finishedAt })
    const executionResults = (details: typeof finished) => details.executions.map(
      ({ id, state, attempt, nativeSessionId, result, finishedAt }) =>
        ({ id, state, attempt, nativeSessionId, result, finishedAt }))
    expect(executionResults(persisted)).toEqual(executionResults(finished))
    for (const original of active) {
      const failedCheck = phase === 'failed admission' && repeatTickIndex(original.input) !== undefined
      expect(finished.executions.find(item => item.id === original.id)).toMatchObject({
        state: 'completed', attempt: original.attempt, nativeSessionId: original.nativeSessionId,
        result: { outcome: failedCheck ? 'failed' : 'succeeded' },
      })
    }
    const calls = await fixture.provider.calls()
    for (const original of active) {
      if (phase !== 'failed admission' || repeatTickIndex(original.input) === undefined) {
        expect(calls.filter(call => call.method === 'turn/start'
          && call.correlationId === `execution:${original.id}`)).toHaveLength(1)
      }
    }
    await readUntil(async () => service.registry.snapshot().launches, values => launches.every(original =>
      values.find(item => item.launchId === original.launchId)?.lifecycle === 'closed'),
    { timeoutMs: 10_000, description: 'reattached native process cleanup' })
    for (const original of launches) {
      if (original.provider) expect(() => process.kill(original.provider!.pid, 0)).toThrow()
    }
    return recovered
  } finally {
    try {
      await fixture.provider.releaseWorkflowAdmission()
      await fixture.provider.releaseWorkflowTurns()
      await restart
    } finally {
      if (!installedFixture) await fixture.close()
    }
  }
}
