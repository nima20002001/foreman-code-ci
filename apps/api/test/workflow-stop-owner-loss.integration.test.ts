import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { DomainError } from '../src/modules/errors.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../src/modules/runs/workflowProduction.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { reserveFromExitedParent } from './helpers/eng06LaunchReservation.testSupport.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'

async function runtime() {
  const recover = vi.fn((id: string, signal: AbortSignal) => registry.closeOwner(`execution:${id}`, signal))
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  const f = await checkpointRuntimeFixture(1, 1, {
    fixture, approvalNodeIds: [fixture.version.entryNodeId], recoverNativeProcesses: recover,
  })
  const root = join(f.db.directory, 'native-owner-registry')
  const registry = new NativeProcessRegistry(root)
  let disconnected = false
  const connection = f.provider.connection.bind(f.provider)
  // Provider transport is synthetic; closure uses an original registry whose OS parent exited.
  vi.spyOn(f.provider, 'connection').mockImplementation((): NativeHarnessSessionManager => {
    const manager = connection()
    return { ...manager,
      createSession: async input => {
        if (isWorkflowStart(input)) reserveFromExitedParent(root, `execution:${input.request.executionId}`)
        return manager.createSession(input)
      },
      cancel: async (...args) => {
        if (disconnected) throw new Error('The original native transport ended.')
        return manager.cancel(...args)
      },
      close: async (...args) => {
        if (disconnected) throw new Error('The original native transport ended.')
        return manager.close(...args)
      },
    }
  })
  return { ...f, registry, recover, disconnect: () => { disconnected = true } }
}

async function operator(f: Awaited<ReturnType<typeof runtime>>,
  active: ReturnType<typeof f.compose> = f) {
  const access = new PostgresAccessService(f.db.pool)
  const commands = new PostgresCommandCoordinator(f.db.pool)
  const production = createCurrentNativeProductionFactory({
    isRuntimeOpen: () => true, reportDispatchFailure: () => undefined,
  })({ primaryPool: f.db.pool, commands, runs: active.runs, workflows: active.workflows,
    locations: active.locations, engine: active.engine, nativeExecutions: active.native,
    interactions: active.service, checkpointer: active.checkpointer })
  const runs = new RunManagementService(f.db.pool, commands, active.runs, active.engine, active.locations, production)
  const workflows = new WorkflowManagementService(f.db.pool, commands)
  const resource = { workspaceIds: [f.f.run.workspaceId] }
  const writer = await access.issue({ name: 'Stop fixture operator', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['runs:read', 'runs:stop', 'workflows:read', 'workflows:archive'], scope: resource }] })
  const reader = await access.issue({ name: 'Stop fixture reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['runs:read', 'workflows:read'], scope: resource }] })
  const app = buildApp({ readiness: { database: { ping: async () => undefined },
    checkpoints: { ping: async () => undefined } },
  operator: { access, services: { commands, runs, workflows } as unknown as OperatorServices } })
  const call = (name: string, args: Record<string, unknown>, token = writer.token) =>
    graphRpc(app, token, 'tools/call', { name, arguments: args })
  const input = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id, commandId: randomUUID() }
  return { app, reader, call, input, workflows, writer }
}

it.each(['api', 'worker'] as const)('settles a Run after %s owner loss and then permits archive through MCP', async kind => {
  const f = await runtime()
  let client: Awaited<ReturnType<typeof operator>> | undefined
  try {
    if (kind === 'api') {
      f.disconnect()
      f.recover.mockResolvedValue(false)
      vi.spyOn(f.runs, 'appendNativeEvents').mockRejectedValueOnce(
        new DomainError('NATIVE_OBSERVATION_LOST', 'Native event observation was interrupted.', 503))
      await expect(f.engine.start(f.f.run.id)).rejects.toThrow()
      f.recover.mockImplementation((id, signal) => f.registry.closeOwner(`execution:${id}`, signal))
      f.recover.mockClear()
    } else {
      await f.engine.start(f.f.run.id)
    }
    const before = await f.runs.getRepeatSnapshot(f.f.run.id)
    expect(before.run.executionState).toBe(kind === 'api' ? 'running' : 'waiting')
    f.disconnect()
    let active: ReturnType<typeof f.compose> = f
    if (kind === 'api') {
      // A dead API cannot publish its old manager's closure during shutdown.
      vi.spyOn(f.native, 'closeForRestart').mockResolvedValue(undefined)
      await f.engine.shutdown()
      active = f.compose()
    }
    client = await operator(f, active)
    const { input, call, reader, workflows, writer } = client
    const denied = await call('run_stop', input, reader.token)
    expect(denied.result?.isError).toBe(true)
    expect(graphRpcValue(denied.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    expect((await active.runs.getRepeatSnapshot(input.runId)).stopRequested).toBe(false)
    expect(f.recover).not.toHaveBeenCalled()
    const saved = await workflows.get(writer.principal, input.workspaceId, f.f.run.workflowId)
    const archive = { workspaceId: input.workspaceId, workflowId: f.f.run.workflowId,
      expectedRevision: saved.revision, commandId: randomUUID() }
    expect((await call('workflow_archive', archive)).result?.isError).toBe(true)
    const stopped = await call('run_stop', input)
    expect(stopped.result?.isError, JSON.stringify(graphRpcValue(stopped.result))).not.toBe(true)
    expect(graphRpcValue(stopped.result)).toMatchObject({ runId: input.runId, status: 'accepted', replayed: false })
    const read = await call('run_get', { workspaceId: input.workspaceId, runId: input.runId, detail: 'full' })
    expect(read.result?.isError).not.toBe(true)
    expect(graphRpcValue(read.result)).toMatchObject({
      run: { id: input.runId, executionState: 'completed', outcome: 'canceled',
        workflowVersionId: before.run.workflowVersionId, input: before.run.input },
      cleanupPending: false,
      executions: [expect.objectContaining({ state: 'completed', result: { outcome: 'canceled' } })],
    })
    expect(f.recover).toHaveBeenCalledTimes(1)
    expect(graphRpcValue((await call('run_stop', input)).result)).toMatchObject({ replayed: true })
    expect(f.recover).toHaveBeenCalledTimes(1)
    const archived = await call('workflow_archive', archive)
    expect(archived.result?.isError, JSON.stringify(graphRpcValue(archived.result))).not.toBe(true)
    expect(graphRpcValue(archived.result)).toMatchObject({ value: { archivedAt: expect.any(String) } })
    expect(graphRpcValue((await call('workflow_get', {
      workspaceId: input.workspaceId, workflowId: archive.workflowId,
    })).result)).toMatchObject({ archivedAt: expect.any(String) })
    expect(f.provider.counts).toEqual({ sessions: 1, starts: 1, responses: 0, attaches: 0 })
  } finally {
    await client?.app.close()
    await f.close()
  }
}, 90_000)

it('reports unconfirmed closure as a domain error and settles on the same MCP Stop retry', async () => {
  const f = await runtime()
  let client: Awaited<ReturnType<typeof operator>> | undefined
  try {
    await f.engine.start(f.f.run.id)
    f.disconnect()
    f.recover.mockRejectedValueOnce(new AggregateError([new Error('Native closure is unconfirmed.')]))
    client = await operator(f)
    const failed = await client.call('run_stop', client.input)
    expect(failed.result?.isError).toBe(true)
    expect(graphRpcValue(failed.result)).toMatchObject({ error: {
      code: 'WORKFLOW_STOP_SETTLEMENT_PENDING', details: { retryable: true },
    } })
    f.recover.mockRejectedValueOnce(new AggregateError([new Error('Native closure is still unconfirmed.')]))
    const http = await client.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${client.input.workspaceId}/runs/${client.input.runId}/stop`,
      headers: graphHeaders(client.writer.token), payload: client.input })
    expect(http.statusCode).toBe(409)
    expect(http.json()).toMatchObject({ error: {
      code: 'WORKFLOW_STOP_SETTLEMENT_PENDING', details: { retryable: true },
    } })
    const pending = await client.call('run_get', {
      workspaceId: client.input.workspaceId, runId: client.input.runId,
    })
    expect(graphRpcValue(pending.result)).toMatchObject({ run: { executionState: 'waiting' }, cleanupPending: true })
    const retried = await client.call('run_stop', client.input)
    expect(retried.result?.isError, JSON.stringify(graphRpcValue(retried.result))).not.toBe(true)
    expect(graphRpcValue(retried.result)).toMatchObject({ runId: client.input.runId, replayed: false })
    expect(await f.runs.getRepeatSnapshot(f.f.run.id)).toMatchObject({
      run: { executionState: 'completed', outcome: 'canceled' }, cleanupPending: false,
    })
    expect(f.provider.counts).toEqual({ sessions: 1, starts: 1, responses: 0, attaches: 0 })
  } finally {
    await client?.app.close()
    await f.close()
  }
}, 90_000)

it('keeps a Run fenced while another live owner holds it', async () => {
  const f = await runtime()
  let client: Awaited<ReturnType<typeof operator>> | undefined
  let owner: Awaited<ReturnType<typeof f.runs.acquireOwnership>> = undefined
  try {
    await f.engine.start(f.f.run.id)
    f.disconnect()
    vi.spyOn(f.native, 'closeForRestart').mockResolvedValue(undefined)
    await f.engine.shutdown()
    const active = f.compose()
    owner = await active.runs.acquireOwnership(f.f.run.id, () => undefined)
    expect(owner).toBeDefined()
    client = await operator(f, active)
    const stopped = await client.call('run_stop', client.input)
    expect(stopped.result?.isError).toBe(true)
    expect(graphRpcValue(stopped.result)).toMatchObject({ error: { code: 'WORKFLOW_STOP_SETTLEMENT_PENDING' } })
    expect(f.recover).not.toHaveBeenCalled()
    expect(await active.runs.getRepeatSnapshot(f.f.run.id)).toMatchObject({
      run: { executionState: 'waiting', outcome: 'pending' }, stopRequested: true,
    })
    await owner?.release()
    owner = undefined
    const retry = await client.call('run_stop', client.input)
    expect(retry.result?.isError, JSON.stringify(graphRpcValue(retry.result))).not.toBe(true)
    expect(f.recover).toHaveBeenCalledTimes(1)
  } finally {
    await owner?.release()
    await client?.app.close()
    await f.close()
  }
}, 90_000)
