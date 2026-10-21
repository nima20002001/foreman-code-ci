import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { WorkspaceLocationSetResultSchema } from '@foreman-code/contracts/management'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema, RunStartV3ResultSchema,
  SavedRunDetailsSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { databaseCredentialDeadline } from '../src/modules/access/credentialLifetime.js'
import { LOCAL_RUNNER_ID } from '../src/modules/workspaces/location.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { rejectableDeferred } from './helpers/deferred.js'

type Runtime = Awaited<ReturnType<typeof currentOperatorIntegration>>

async function activeWorkflow(mode: 'running' | 'waiting' = 'running') {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  const runtime = await currentOperatorIntegration({ fixture, insertRun: false,
    approvalNodeIds: mode === 'waiting' ? [fixture.version.entryNodeId] : [],
  })
  const connection = runtime.provider.connection.bind(runtime.provider)
  vi.spyOn(runtime.provider, 'connection').mockImplementation((): NativeHarnessSessionManager => {
    const manager = connection()
    return { ...manager, canDetachForRestart: () => true,
      async *startTurn(session, input, signal) {
        for await (const event of manager.startTurn(session, input, signal)) {
          yield event
          if (event.type === 'turn.started' && mode === 'running') {
            await new Promise<void>((_resolve, reject) => {
              if (signal?.aborted) reject(signal.reason)
              else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
          }
        }
      },
    }
  })
  return runtime
}

async function start(runtime: Runtime) {
  const locationResponse = await runtime.client.callTool({ name: 'workspace_location_set', arguments: {
    workspaceId: runtime.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
    runnerId: LOCAL_RUNNER_ID, rootPath: runtime.db.directory,
  } })
  expect(locationResponse.isError).not.toBe(true)
  const location = WorkspaceLocationSetResultSchema.parse(decodeMcpToolResult(locationResponse)).value
  const savedResponse = await runtime.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save,
    arguments: await runtime.create() })
  expect(savedResponse.isError).not.toBe(true)
  const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedResponse)).value
  const input = {
    workspaceId: saved.workspaceId, workflowId: saved.workflowId, workflowVersionId: saved.version.id,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: saved.revision,
    expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    expectedLocationRevision: location.locationRevision, input: {},
  }
  const reader = await runtime.access.issue({ name: 'Restart readback reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 300_000),
    grants: [{ actions: ['runs:read'], scope: { workspaceIds: [saved.workspaceId] } }] })
  const deniedClient = await runtime.connect(reader.token)
  const denied = await deniedClient.callTool({ name: 'run_start', arguments: input })
  expect(denied.isError).toBe(true)
  expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  const response = await runtime.client.callTool({ name: 'run_start', arguments: input })
  expect(response.isError, JSON.stringify(decodeMcpToolResult(response))).not.toBe(true)
  const started = RunStartV3ResultSchema.parse(decodeMcpToolResult(response))
  const read = async () => {
    const result = await deniedClient.callTool({ name: 'run_get', arguments: {
      workspaceId: saved.workspaceId, runId: started.run.id, detail: 'full',
    } })
    expect(result.isError).not.toBe(true)
    return SavedRunDetailsSchema.parse(decodeMcpToolResult(result))
  }
  const details = await readUntil(read, value => value.activity.some(activity =>
    activity.payload.nativeEventType === 'turn.started'),
  { timeoutMs: 30_000, description: 'persisted active native turn' })
  return { run: started.run, execution: details.executions[0]!, read }
}

async function lease(runtime: Runtime, executionId: string) {
  const row = (await runtime.db.pool.query<{
    principal_id: string; expires_at: Date; token_hash: string; live: boolean
  }>(`select p.id as principal_id,p.expires_at,p.token_hash,
    p.revoked_at is null and b.revoked_at is null and p.expires_at>clock_timestamp() as live
    from management_principals p join worker_credential_bindings b on b.principal_id=p.id
    where b.execution_id=$1`, [executionId])).rows[0]!
  return row
}

async function detachment(runtime: Runtime, executionId: string) {
  return (await runtime.db.pool.query<{ detached: boolean; closed: boolean }>(`select
    detached_at is not null as detached,closed_at is not null as closed
    from execution_native_closures where execution_id=$1 order by generation desc limit 1`,
  [executionId])).rows[0]
}

describe.runIf(postgresEnabled)('restart credential safety', () => {
  it('joins an in-flight heartbeat renewal without canceling or replacing the native execution', async () => {
    const runtime = await activeWorkflow()
    const release = rejectableDeferred()
    const issue = Wave25WorkerCredentialService.prototype.issueForExecution
    const issued = vi.spyOn(Wave25WorkerCredentialService.prototype, 'issueForExecution')
      .mockImplementation(async function (this: Wave25WorkerCredentialService, id) {
        const credential = await issue.call(this, id)
        const requestedAt = performance.now()
        const shortened = (await runtime.db.pool.query<{ expires_at: Date; database_now: Date }>(
          `update management_principals set expires_at=clock_timestamp()+interval '45 seconds'
           where id=$1 returning expires_at,clock_timestamp() as database_now`,
          [credential.principalId])).rows[0]!
        return { ...credential, expiresAt: shortened.expires_at.toISOString(),
          renewalDeadline: databaseCredentialDeadline(shortened.expires_at, shortened.database_now, requestedAt) }
      })
    const renew = Wave25WorkerCredentialService.prototype.renewForExecution
    let calls = 0
    const renewal = vi.spyOn(Wave25WorkerCredentialService.prototype, 'renewForExecution')
      .mockImplementation(async function (this: Wave25WorkerCredentialService, id, credential) {
        calls++
        if (calls === 1) {
          await release.promise
        }
        return renew.call(this, id, credential)
      })
    let shutdown: Promise<void> | undefined
    try {
      const active = await start(runtime)
      await readUntil(async () => calls, count => count > 0,
        { timeoutMs: 10_000, description: 'the short-lived Worker heartbeat renewal' })
      const original = await lease(runtime, active.execution.id)
      shutdown = runtime.engine.shutdown()
      await readUntil(async () => (await runtime.db.pool.query<{ paused: boolean }>(`select
        active_started_at is null as paused from approval_execution_state where execution_id=$1`,
      [active.execution.id])).rows[0]?.paused, paused => paused === true,
      { timeoutMs: 10_000, description: 'restart budget pause' })
      // The paused restart must wait for the original heartbeat, rather than renewing concurrently.
      expect(calls).toBe(1)
      release.resolve()
      await shutdown
      const preserved = await active.read()
      expect(preserved.executions).toEqual([active.execution])
      expect(preserved.run).toMatchObject({ id: active.run.id, outcome: 'pending' })
      expect(await detachment(runtime, active.execution.id)).toEqual({ detached: true, closed: false })
      const renewed = await lease(runtime, active.execution.id)
      expect(renewed).toMatchObject({
        principal_id: original.principal_id, token_hash: original.token_hash, live: true,
      })
      expect(renewed.expires_at.getTime()).toBeGreaterThan(original.expires_at.getTime())
      expect(runtime.provider.counts).toMatchObject({ sessions: 1, starts: 1, responses: 0 })
      const cleanup = await runtime.db.pool.query('select run_id from run_cleanup_intents where run_id=$1 and pending',
        [active.run.id])
      expect(cleanup.rows).toEqual([])
    } finally {
      release.resolve()
      await shutdown?.catch(() => {
        // ignore: cleanup joins shutdown without masking the test failure and still restores its mocks.
      })
      issued.mockRestore()
      renewal.mockRestore()
      await runtime.close()
    }
  }, 60_000)

  it.each(['revoked', 'missing grants'] as const)(
    'refuses to extend or detach a Worker whose accepting principal has %s', async authority => {
      const runtime = await activeWorkflow()
      try {
        const active = await start(runtime)
        const original = await lease(runtime, active.execution.id)
        if (authority === 'revoked') await runtime.access.revoke(runtime.writer.principal.id)
        else await runtime.db.pool.query("update management_principals set grants='[]'::jsonb where id=$1",
          [runtime.writer.principal.id])
        await runtime.engine.shutdown()
        const rejected = await lease(runtime, active.execution.id)
        expect(rejected).toMatchObject({ principal_id: original.principal_id, token_hash: original.token_hash,
          expires_at: original.expires_at, live: false })
        expect(await detachment(runtime, active.execution.id)).toEqual({ detached: false, closed: true })
        expect((await active.read()).executions).toEqual([active.execution])
        const cleanup = await runtime.db.pool.query('select run_id from run_cleanup_intents where run_id=$1 and pending',
          [active.run.id])
        expect(cleanup.rows).toEqual([{ run_id: active.run.id }])
      } finally {
        await runtime.close()
      }
    }, 60_000,
  )

  it('waits for a competing owner before cleaning up a revoked waiting Worker', async () => {
    const runtime = await activeWorkflow('waiting')
    let competitor: RunOwnership | undefined
    let shutdown: Promise<void> | undefined
    const acquireOwnership = runtime.runs.acquireOwnership.bind(runtime.runs)
    let blocked = false
    const acquire = vi.spyOn(runtime.runs, 'acquireOwnership').mockImplementation(async (runId, onLost) => {
      const owner = await acquireOwnership(runId, onLost)
      if (!owner) blocked = true
      return owner
    })
    try {
      const active = await start(runtime)
      const waiting = await readUntil(active.read, details => details.run.executionState === 'waiting',
        { timeoutMs: 30_000, description: 'the graph yielding for approval' })
      await runtime.engine.start(active.run.id)
      competitor = await acquireOwnership(active.run.id, () => undefined)
      expect(competitor).toBeDefined()
      const original = await lease(runtime, active.execution.id)
      await runtime.access.revoke(runtime.writer.principal.id)
      shutdown = runtime.engine.shutdown()
      await readUntil(async () => blocked, value => value,
        { timeoutMs: 10_000, description: 'restart waiting for the competing Run owner' })
      expect(await detachment(runtime, active.execution.id)).toEqual({ detached: false, closed: false })
      expect((await lease(runtime, active.execution.id)).expires_at).toEqual(original.expires_at)
      expect(runtime.provider.closedSessions.has(active.execution.nativeSessionId!)).toBe(false)
      await competitor!.release()
      competitor = undefined
      await shutdown
      expect(await lease(runtime, active.execution.id)).toMatchObject({
        principal_id: original.principal_id, expires_at: original.expires_at, live: false,
      })
      expect(await detachment(runtime, active.execution.id)).toEqual({ detached: false, closed: true })
      const persisted = await active.read()
      expect(persisted.run.outcome).toBe('pending')
      expect(persisted.executions).toEqual(waiting.executions)
      expect(runtime.provider.counts).toMatchObject({ sessions: 1, starts: 1, responses: 0 })
      expect(await runtime.runs.hasPendingCleanup(active.run.id)).toBe(true)
    } finally {
      try {
        await competitor?.release()
        await shutdown
      } finally {
        acquire.mockRestore()
        await runtime.close()
      }
    }
  }, 60_000)

  it.each(['connection failure', 'revoked worker'] as const)(
    'does not preserve a Worker after a %s during renewal', async failure => {
      const runtime = await activeWorkflow()
      const renewal = vi.spyOn(Wave25WorkerCredentialService.prototype, 'renewForExecution')
      let principalId: string | undefined
      try {
        const active = await start(runtime)
        const original = await lease(runtime, active.execution.id)
        principalId = original.principal_id
        if (failure === 'connection failure') {
          renewal.mockRejectedValueOnce(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }))
        } else await runtime.access.revoke(principalId)
        if (failure === 'revoked worker') {
          await runtime.engine.shutdown()
          expect(await lease(runtime, active.execution.id)).toMatchObject({
            principal_id: principalId, expires_at: original.expires_at, live: false,
          })
          expect(await detachment(runtime, active.execution.id)).toEqual({ detached: false, closed: true })
          return
        }
        await expect(runtime.engine.shutdown()).rejects.toBeInstanceOf(AggregateError)
        expect((await lease(runtime, active.execution.id)).expires_at).toEqual(original.expires_at)
        expect(await detachment(runtime, active.execution.id)).toEqual({ detached: false, closed: false })
        expect((await active.read()).executions).toEqual([active.execution])
        await runtime.engine.shutdown()
        expect(await detachment(runtime, active.execution.id)).toEqual({ detached: true, closed: false })
        const renewed = await lease(runtime, active.execution.id)
        expect(renewed).toMatchObject({ principal_id: principalId, token_hash: original.token_hash, live: true })
        expect(renewed.expires_at.getTime()).toBeGreaterThan(original.expires_at.getTime())
        expect(runtime.provider.counts).toMatchObject({ sessions: 1, starts: 1 })
      } finally {
        renewal.mockRestore()
        await runtime.close()
      }
    }, 60_000,
  )
})
