import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { DomainError } from '../src/modules/errors.js'
import { withClientTransaction } from '../src/infrastructure/transaction.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../src/modules/runs/workflowProduction.js'
import { admitWorkflowStopIntent } from '../src/modules/runs/workflowStopAdmission.js'
import type { CurrentStopContext } from '../src/modules/runs/currentProduction.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { checkpointRuntimeFixture, insertProviderRun } from './helpers/wave25Br1003Runtime.js'

async function runtime() {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  return checkpointRuntimeFixture(1, 1, {
    fixture, approvalNodeIds: [fixture.version.entryNodeId], workerParallelism: 4,
  })
}

it('stops an orphan through authenticated MCP while preserving other Runs of the same Agent', async () => {
  const f = await runtime()
  const access = new PostgresAccessService(f.db.pool)
  const commands = new PostgresCommandCoordinator(f.db.pool)
  const production = createCurrentNativeProductionFactory({
    isRuntimeOpen: () => true,
    reportDispatchFailure: () => undefined,
  })({ primaryPool: f.db.pool, commands, runs: f.runs, workflows: f.workflows,
    locations: f.locations, engine: f.engine, nativeExecutions: f.native,
    interactions: f.service, checkpointer: f.saver })
  const runs = new RunManagementService(f.db.pool, commands, f.runs, f.engine, f.locations, production)
  const app = buildApp({ readiness: { database: { ping: async () => undefined },
    checkpoints: { ping: async () => undefined } },
  operator: { access, services: { commands, runs } as unknown as OperatorServices } })
  const resource = { workspaceIds: [f.f.run.workspaceId] }
  const writer = await access.issue({ name: 'Stop operator', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['runs:read', 'runs:stop'], scope: resource }] })
  const reader = await access.issue({ name: 'Run reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['runs:read'], scope: resource }] })
  const others: string[] = []
  const append = f.runs.appendNativeEvents.bind(f.runs)
  let fail = true
  vi.spyOn(f.runs, 'appendNativeEvents').mockImplementation(async (...args) => {
    if (args[1].runId === f.f.run.id && fail) {
      fail = false
      throw new DomainError('NATIVE_OBSERVATION_LOST', 'Native event observation was interrupted.', 503)
    }
    return append(...args)
  })
  try {
    for (let index = 0; index < 3; index += 1) {
      const run = WorkflowRunV3Schema.parse({ ...f.f.run, id: `run-${randomUUID()}` })
      await insertProviderRun(f.db.pool, { ...f.f, run })
      others.push(run.id)
    }
    const starts = await Promise.allSettled([f.f.run.id, ...others].map(id => f.engine.start(id)))
    expect(starts[0]?.status).toBe('rejected')
    expect(starts.slice(1).every(result => result.status === 'fulfilled')).toBe(true)
    const execution = (await f.db.pool.query<{ record: { id: string; nativeSessionId: string; state: string } }>(
      'select record from harness_executions where run_id=$1', [f.f.run.id])).rows[0]!.record
    await f.provider.close({ harness: 'codex', providerVersion: '0.154.0', nativeSessionId: execution.nativeSessionId })
    const input = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id, commandId: randomUUID() }
    const denied = await graphRpc(app, reader.token, 'tools/call', { name: 'run_stop', arguments: input })
    expect(denied.result?.isError).toBe(true)
    expect((await f.runs.getRepeatSnapshot(f.f.run.id)).stopRequested).toBe(false)
    const stopped = await graphRpc(app, writer.token, 'tools/call', { name: 'run_stop', arguments: input })
    expect(stopped.result?.isError, JSON.stringify(graphRpcValue(stopped.result))).not.toBe(true)
    expect(graphRpcValue(stopped.result)).toMatchObject({ runId: f.f.run.id, status: 'accepted', replayed: false })
    const read = await graphRpc(app, writer.token, 'tools/call', {
      name: 'run_get', arguments: { workspaceId: input.workspaceId, runId: input.runId },
    })
    expect(read.result?.isError).not.toBe(true)
    expect(graphRpcValue(read.result)).toMatchObject({ run: { executionState: 'completed' } })
    const snapshot = await f.runs.getRepeatSnapshot(f.f.run.id)
    expect(snapshot).toMatchObject({ stopRequested: true, cleanupPending: false,
      run: { executionState: 'completed' } })
    const replay = await graphRpc(app, writer.token, 'tools/call', { name: 'run_stop', arguments: input })
    expect(graphRpcValue(replay.result)).toMatchObject({ runId: input.runId, replayed: true })
    for (const id of others) {
      expect(await f.runs.getRepeatSnapshot(id)).toMatchObject({ stopRequested: false,
        run: { executionState: 'waiting' } })
    }
    expect(f.provider.counts.starts).toBe(4)
  } finally {
    await app.close()
    await f.close()
  }
}, 90_000)

it('replays an immutable Stop intent while another reader retains the saved intent', async () => {
  const f = await runtime()
  const principal = await readLiveManagementPrincipal(f.db.pool, f.authorizationPrincipalId)
  const context: CurrentStopContext = { principal, source: 'mcp', run: f.f.run,
    input: { workspaceId: f.f.run.workspaceId, runId: f.f.run.id, commandId: randomUUID() },
    authorizeLocked: async sql => {
      const live = await readLiveManagementPrincipal(sql as unknown as Pick<pg.ClientBase, 'query'>, principal.id)
      requireAuthorization(live, 'runs:stop', { workspaceId: f.f.run.workspaceId, runId: f.f.run.id,
        workflowId: f.f.run.workflowId })
    } }
  const pool = new pg.Pool({ ...f.db.pool.options,
    options: `${f.db.pool.options.options} -c statement_timeout=1000 -c lock_timeout=2000` })
  const reader = await f.db.pool.connect()
  try {
    const first = await admitWorkflowStopIntent(f.db.pool, context)
    await withClientTransaction(reader, async () => {
      await reader.query('select record from workflow_stop_intents where run_id=$1 for share', [f.f.run.id])
      expect(await admitWorkflowStopIntent(pool, context)).toEqual(first)
      expect(await f.runs.getRepeatSnapshot(f.f.run.id)).toMatchObject({ stopRequested: true })
    })
  } finally {
    reader.release()
    await pool.end()
    await f.close()
  }
}, 60_000)
