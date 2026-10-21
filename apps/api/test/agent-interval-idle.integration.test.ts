import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SavedRunDetailsSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../src/modules/runs/workflowProduction.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('idle interval Run lifetime', () => {
  it.each([false, true])('checks after graph settlement and restart until MCP Stop (handoffs=%s)', async (handoffs) => {
    const definition = makeCurrentWorkflowFixture(randomUUID(), 'single')
    agentWorkflowNode(definition.version.definition.nodes[0]).interval = { everySeconds: 10 }
    if (handoffs) definition.version.definition.handoffs = { contractVersion: 1 }
    const fixture = await codexApprovalRuntime('user', { fixture: definition, approvalPolicy: 'never',
      workflowOutput: async () => handoffs ? JSON.stringify({ routing: { kind: 'finish' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [] } }) : 'Check complete',
    })
    let runtime: ReturnType<typeof fixture.compose> = fixture
    const commands = new PostgresCommandCoordinator(fixture.db.pool)
    const writer = await fixture.access.issue({ name: 'Loop operator', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read', 'runs:stop'],
        scope: { workspaceIds: [fixture.f.run.workspaceId] } }] })
    const reader = await fixture.access.issue({ name: 'Loop reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
        scope: { workspaceIds: [fixture.f.run.workspaceId] } }] })
    const openApp = () => {
      const production = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
        reportDispatchFailure: (runId, _code, error) => { throw new Error(`Dispatch failed for ${runId}`, { cause: error }) },
      })({ primaryPool: fixture.db.pool, commands, runs: runtime.runs, workflows: runtime.workflows,
        locations: runtime.locations, engine: runtime.engine, nativeExecutions: runtime.native,
        interactions: runtime.service, checkpointer: fixture.saver })
      const runs = new RunManagementService(fixture.db.pool, commands, runtime.runs, runtime.engine,
        runtime.locations, production)
      return buildApp({ logger: false, readiness: { database: { ping: async () => undefined },
        checkpoints: { ping: async () => undefined } },
      operator: { access: fixture.access, services: { runs, commands } as unknown as OperatorServices } })
    }
    let app = openApp()
    const scope = { workspaceId: fixture.f.run.workspaceId, runId: fixture.f.run.id }
    const read = async () => {
      const response = await graphRpc(app, reader.token, 'tools/call', {
        name: 'run_get', arguments: { ...scope, detail: 'full' },
      })
      expect(response.result?.isError).not.toBe(true)
      return SavedRunDetailsSchema.parse(graphRpcValue(response.result))
    }
    const completedChecks = (details: Awaited<ReturnType<typeof read>>) => details.executions.filter(
      execution => execution.state === 'completed' && typeof execution.input === 'object'
        && execution.input !== null && !Array.isArray(execution.input) && execution.input.tick,
    )
    const waitForChecks = (count: number) => readUntil(read, details => completedChecks(details).length >= count,
      { timeoutMs: 40_000, minimumReadIntervalMs: 100, description: `${count} completed interval checks` })
    const started = Promise.allSettled([runtime.engine.start(scope.runId)])
    try {
      const idle = await waitForChecks(2)
      expect(idle.run.executionState).toBe('running')
      expect(idle.executions.filter(execution => !completedChecks(idle).includes(execution)))
        .toMatchObject([{ state: 'completed' }])
      const originalIds = idle.executions.map(execution => execution.id)
      await runtime.engine.shutdown()
      await started
      await app.close()
      runtime = fixture.compose()
      app = openApp()
      await runtime.engine.reconcile(error => { throw error })
      const recovered = await waitForChecks(3)
      expect(recovered.run.executionState).toBe('running')
      expect(recovered.executions.map(execution => execution.id)).toEqual(expect.arrayContaining(originalIds))
      expect(recovered.executions.filter(execution => typeof execution.input !== 'object'
        || execution.input === null || Array.isArray(execution.input) || !execution.input.tick)).toHaveLength(1)
      const stop = { ...scope, commandId: randomUUID() }
      const denied = await graphRpc(app, reader.token, 'tools/call', { name: 'run_stop', arguments: stop })
      expect(denied.result?.isError).toBe(true)
      expect((await read()).run.executionState).toBe('running')
      const accepted = await graphRpc(app, writer.token, 'tools/call', { name: 'run_stop', arguments: stop })
      expect(accepted.result?.isError, JSON.stringify(graphRpcValue(accepted.result))).not.toBe(true)
      const finished = await readUntil(read, details => details.run.executionState === 'completed',
        { timeoutMs: 10_000, description: 'stopped interval Run' })
      expect(finished.run.outcome).toBe('canceled')
      expect((await runtime.runs.getRepeatSnapshot(scope.runId)).stopRequested).toBe(true)
      const count = finished.executions.length
      await runtime.engine.reconcile(error => { throw error })
      expect((await read()).executions).toHaveLength(count)
    } finally {
      await app.close()
      await fixture.close()
      await started
    }
  }, 120_000)
})
