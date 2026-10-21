import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { installationUpdateFixture, startWhenReady, runningTurn, completedRun } from './helpers/harnessInstallationUpdate.js'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

type Fixture = Awaited<ReturnType<typeof installationUpdateFixture>>

it('reports an early authenticated MCP failure before the Worker starts', async () => {
  const callTool = Client.prototype.callTool
  // Exercise a real MCP error before setup reaches Worker initialization.
  const request = vi.spyOn(Client.prototype, 'callTool').mockImplementationOnce(function (this: Client) {
    return callTool.call(this, { name: 'workspace_get', arguments: { workspaceId: 'missing-workspace' } })
  })
  try {
    await expect(installationUpdateFixture({ workflow: 'single', executionHost: 'worker' }))
      .rejects.toThrow(/WORKSPACE_NOT_FOUND[\s\S]*Main stderr:[\s\S]*Worker stderr:/)
    expect(request).toHaveBeenCalledTimes(1)
  } finally {
    request.mockRestore()
  }
}, 240_000)

async function active(f: Fixture) {
  await f.provider.blockWorkflowTurns()
  const started = (await startWhenReady(f))!
  const original = await runningTurn(f)
  const details = await waitForRemoteReview(() => f.details(started.run.id), value =>
    value.activity.some(item => item.payload.nativeEventType === 'turn.started'), 'published original turn')
  expect(details.executions).toHaveLength(1)
  return { started, original, execution: details.executions[0]! }
}

async function readCompleted(f: Fixture, original: Awaited<ReturnType<typeof active>>) {
  const { started, execution } = original
  const reader = await f.access.issue({ name: 'Run recovery reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
      scope: { workspaceIds: [started.run.workspaceId], workflowIds: [started.run.workflowId] } }] })
  await expectMcpAccessDenied(f.call('run_stop', { workspaceId: started.run.workspaceId,
    runId: started.run.id, commandId: randomUUID() }, reader.token))
  await f.provider.releaseWorkflowTurns()
  const finished = await completedRun(f, started.run.id)
  expect(finished.executions).toHaveLength(1)
  expect(finished.executions[0]).toMatchObject({ id: execution.id, nativeSessionId: execution.nativeSessionId,
    attempt: execution.attempt, state: 'completed', result: { outcome: 'succeeded' } })
  const readback = SavedRunDetailsSchema.parse(decodeMcpToolResult(await f.call('run_get', {
    workspaceId: started.run.workspaceId, runId: started.run.id, detail: 'full',
  }, reader.token)))
  // This Run reader has no workspace-location access, so MCP redacts execution paths.
  const publicExecutions = finished.executions.map(execution => {
    const value = { ...execution }
    delete value.workingDirectory
    delete value.runtimeDirectory
    return value
  })
  expect(readback.executions).toEqual(publicExecutions)
  for (const execution of readback.executions) {
    expect(execution).not.toHaveProperty('workingDirectory')
    expect(execution).not.toHaveProperty('runtimeDirectory')
  }
  const calls = await f.provider.calls()
  expect(calls.filter(call => call.method === 'turn/start'
    && call.correlationId === `execution:${execution.id}`)).toHaveLength(1)
  expect(calls.some(call => call.method === 'turn/interrupt' && call.threadId === execution.nativeSessionId)).toBe(false)
}

it('gracefully shuts down with an offline Worker and preserves its credential and execution', async () => {
  const f = await installationUpdateFixture({ workflow: 'single', executionHost: 'worker',
    installationRefreshIntervalMs: 60_000 })
  try {
    const original = await active(f)
    const credential = (await f.db.pool.query<{ principal_id: string; token_hash: string; expires_at: Date }>(
      `select b.principal_id,p.token_hash,p.expires_at from worker_credential_bindings b
       join management_principals p on p.id=b.principal_id where b.execution_id=$1 and b.revoked_at is null`,
      [original.execution.id])).rows[0]!
    f.pauseWorkerConnection()
    await waitForRemoteReview(() => f.inventory(), inventory =>
      inventory.hostMetadata?.connection?.phase === 'offline' || inventory.hostMetadata?.connection === null,
    'offline Worker observation')
    await f.restartMain({ mode: 'graceful', afterShutdown: async () => {
      const persisted = (await f.db.pool.query<{ principal_id: string; token_hash: string; live: boolean;
        expires_at: Date; detached: boolean }>(
        `select b.principal_id,p.token_hash,p.expires_at,p.revoked_at is null and b.revoked_at is null as live,
          c.detached_at is not null and c.closed_at is null as detached
         from worker_credential_bindings b join management_principals p on p.id=b.principal_id
         join execution_native_closures c on c.execution_id=b.execution_id
         where b.execution_id=$1 order by c.generation desc limit 1`, [original.execution.id])).rows[0]!
      expect(persisted).toMatchObject({ principal_id: credential.principal_id, token_hash: credential.token_hash,
        live: true, detached: true })
      expect(persisted.expires_at.getTime()).toBeGreaterThan(credential.expires_at.getTime())
      expect(() => process.kill(original.original.pid, 0)).not.toThrow()
      f.resumeWorkerConnection()
    } })
    await readCompleted(f, original)
  } finally {
    f.resumeWorkerConnection()
    await f.provider.releaseWorkflowTurns()
    await f.close()
  }
}, 240_000)

it('refreshes the authenticated history after a physical-readout reconnect without abandoning the turn', async () => {
  const f = await installationUpdateFixture({ workflow: 'single', executionHost: 'worker',
    installationRefreshIntervalMs: 60_000 })
  try {
    const original = await active(f)
    const previous = (await f.inventory()).hostMetadata!.connection!.binding
    await f.dropNextPhysicalReadout()
    await waitForRemoteReview(() => f.inventory(), inventory => {
      const binding = inventory.hostMetadata?.connection?.binding
      return binding?.bootId === previous.bootId && binding.connectionGeneration > previous.connectionGeneration
    }, 'same Worker boot reconnecting')
    await readCompleted(f, original)
  } finally {
    await f.provider.releaseWorkflowTurns()
    await f.close()
  }
}, 240_000)
