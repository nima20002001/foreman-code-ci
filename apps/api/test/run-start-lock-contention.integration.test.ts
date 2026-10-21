import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema, RunStartV3InputSchema, RunStartV3ResultSchema,
  SavedRunDetailsSchema, makeCurrentWorkflowFixture, type RunStartV3Input,
} from '@foreman-code/contracts/wave25'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../src/infrastructure/transaction.js'
import { createPool } from '../src/infrastructure/pool.js'
import { LOCAL_RUNNER_ID } from '../src/modules/workspaces/location.js'
import { answerForRun } from './helpers/coordinationEnvelope.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

type Runtime = Awaited<ReturnType<typeof currentOperatorIntegration>>
type Starter = { runtime: Runtime; input: RunStartV3Input }

describe.runIf(postgresEnabled)('authenticated Start lock contention', () => {
  let database: Awaited<ReturnType<typeof migratedDatabase>>
  let pool: pg.Pool
  beforeAll(async () => {
    database = await migratedDatabase()
    pool = createPool({ connectionString: database.databaseUrl, maxConnections: 16,
      connectionTimeoutMs: 5_000, queryTimeoutMs: 1_000 }, 'run-start-lock-test')
  }, 60_000)
  afterAll(async () => {
    await pool?.end()
    await database?.close()
  }, 60_000)

  async function waitForQueuedStarts(minimum: number) {
    // Nonblocking lock probes leave transactions open rather than creating pg_locks waiters.
    await vi.waitFor(async () => {
      const queued = await database.pool.query<{ count: number }>(`select count(*)::int as count
        from pg_stat_activity where datname=current_database()
        and application_name='run-start-lock-test'
        and state='idle in transaction'
        and query='select pg_try_advisory_xact_lock(hashtext($1)) as locked'
        and clock_timestamp()-xact_start > interval '2.5 seconds'`)
      expect(queued.rows[0]!.count).toBeGreaterThanOrEqual(minimum)
    }, { timeout: 5_000, interval: 20 })
  }

  async function createStarters(runtimes: Runtime[]): Promise<Starter[]> {
    const starters: Starter[] = []
    for (let workspace = 0; workspace < 2; workspace++) {
      const fixture = makeCurrentWorkflowFixture(randomUUID(), workspace === 0 ? 'single' : 'repeat')
      const runtime = await currentOperatorIntegration({ database: { ...database, pool },
        fixture, approvalNodeIds: [], insertRun: false,
        outputFor: (nodeId, request) => nodeId === fixture.version.definition.repeat?.blocks[0]?.exitNodeId
          ? { text: JSON.stringify(answerForRun(request, { routing: { outcome: 'pass' },
            data: { latestDeliverable: { complete: true }, remainingFindings: [] } })) }
          : answerForRun(request, { data: { node: nodeId } }) })
      runtimes.push(runtime)
      const location = await runtime.client.callTool({ name: 'workspace_location_set', arguments: {
        workspaceId: runtime.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
        runnerId: LOCAL_RUNNER_ID, rootPath: database.directory,
      } })
      expect(location.isError).not.toBe(true)
      for (let workflow = 0; workflow < 2; workflow++) {
        const save = await runtime.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save,
          arguments: await runtime.create() })
        expect(save.isError).not.toBe(true)
        const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(save)).value
        const input = RunStartV3InputSchema.parse({ workspaceId: saved.version.workspaceId,
          workflowId: saved.workflowId, workflowVersionId: saved.version.id, executionSemanticsVersion: 3,
          commandId: randomUUID(), expectedWorkflowRevision: saved.revision,
          expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
          expectedLocationRevision: 2, input: { instruction: 'Start contention regression' } })
        starters.push({ runtime, input })
      }
    }
    return starters
  }

  async function assertSettled(starter: Starter, runId: string) {
    // Start accepts asynchronously; teardown must wait for native cleanup as well as the terminal Run.
    await vi.waitFor(async () => {
      const response = await starter.runtime.client.callTool({ name: 'run_get', arguments: {
        workspaceId: starter.input.workspaceId, runId, detail: 'full',
      } })
      expect(response.isError).not.toBe(true)
      const details = SavedRunDetailsSchema.parse(decodeMcpToolResult(response))
      expect(details).toMatchObject({ run: { id: runId, executionState: 'completed', outcome: 'succeeded' },
        cleanupPending: false })
    }, { timeout: 25_000, interval: 50 })
  }

  async function assertPersisted(starter: Starter, runId: string) {
    const response = await starter.runtime.client.callTool({ name: 'run_get', arguments: {
      workspaceId: starter.input.workspaceId, runId, detail: 'full',
    } })
    expect(response.isError).not.toBe(true)
    expect(decodeMcpToolResult(response)).toMatchObject({ run: { id: runId,
      workflowId: starter.input.workflowId, workflowVersionId: starter.input.workflowVersionId,
      executionLocation: { runnerId: LOCAL_RUNNER_ID },
    } })
    const persisted = await database.pool.query(`select r.id,r.workflow_id,r.workspace_id,r.runner_id,
      c.result->>'id' as receipt_run_id from runs r join management_command_receipts c
      on c.operation='run.start' and c.result->>'id'=r.id
      where r.id=$1 and c.principal_id=$2 and c.command_id=$3`,
    [runId, starter.runtime.writer.principal.id, starter.input.commandId])
    expect(persisted.rows).toEqual([{ id: runId, workflow_id: starter.input.workflowId,
      workspace_id: starter.input.workspaceId, runner_id: LOCAL_RUNNER_ID, receipt_run_id: runId }])
    await assertSettled(starter, runId)
  }

  it('waits for repeat native closure after Start acceptance before teardown', async () => {
    const runtimes: Runtime[] = []
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    try {
      const starter = (await createStarters(runtimes))[2]!
      let closing = false
      starter.runtime.provider.beforeClose = async () => {
        closing = true
        await closeGate
      }
      const response = await starter.runtime.client.callTool({ name: 'run_start', arguments: starter.input })
      expect(response.isError).not.toBe(true)
      const started = RunStartV3ResultSchema.parse(decodeMcpToolResult(response))
      expect(started).toMatchObject({ accepted: true, replayed: false })
      // Acceptance is asynchronous: dispatch, the first native turn and its result persistence all run
      // before closure, which took over 5 s on a loaded CI machine. Same budget as settlement below.
      await vi.waitFor(() => { expect(closing).toBe(true) }, { timeout: 25_000, interval: 20 })

      const callTool = starter.runtime.client.callTool.bind(starter.runtime.client)
      let sawPending = false
      vi.spyOn(starter.runtime.client, 'callTool').mockImplementation(async (...args) => {
        const read = await callTool(...args)
        if (args[0].name === 'run_get') {
          const details = SavedRunDetailsSchema.parse(decodeMcpToolResult(read))
          sawPending ||= details.run.executionState !== 'completed'
          // Release only after the public read captures the unsettled Run.
          releaseClose()
        }
        return read
      })
      await assertSettled(starter, started.run.id)
      const settled = await starter.runtime.client.callTool({ name: 'run_get', arguments: {
        workspaceId: starter.input.workspaceId, runId: started.run.id, detail: 'full',
      } })
      expect(settled.isError).not.toBe(true)
      const details = SavedRunDetailsSchema.parse(decodeMcpToolResult(settled))
      expect(details.executions).toHaveLength(2)
      expect(details.executions).toEqual(expect.arrayContaining([expect.objectContaining({
        result: expect.objectContaining({ outcome: 'succeeded', output: { text: expect.any(String) } }),
      })]))
      const exitResults = details.executions.flatMap(execution => {
        const output = execution.result?.output
        return output && typeof output === 'object' && 'text' in output && typeof output.text === 'string'
          ? [JSON.parse(output.text) as unknown] : []
      })
      expect(exitResults).toContainEqual(expect.objectContaining({
        routing: { outcome: 'pass' }, data: { latestDeliverable: { complete: true }, remainingFindings: [] },
      }))
      expect(starter.runtime.provider.closedSessions.size).toBe(2)
      expect(sawPending).toBe(true)
      expect(starter.runtime.provider.counts.starts).toBe(2)
      expect(starter.runtime.dispatchErrors).toEqual([])
    } finally {
      releaseClose()
      for (const runtime of runtimes.reverse()) await runtime.close()
      vi.restoreAllMocks()
    }
  }, 90_000)

  it.each(['runner', 'workspace'] as const)(
    'queues four workflows across two workspaces beyond SQL deadlines at the %s lock', async (lockKind) => {
      const runtimes: Runtime[] = []
      const snapshots: { mockRestore(): void }[] = []
      const holder = await database.pool.connect()
      let pending: Promise<unknown>[] = []
      try {
        const starters = await createStarters(runtimes)
        expect(new Set(starters.map(({ input }) => input.workflowId)).size).toBe(4)
        expect(new Set(starters.map(({ input }) => input.workspaceId)).size).toBe(2)
        const key = lockKind === 'runner' ? `admission:runner:${LOCAL_RUNNER_ID}`
          : `admission:workspace:${starters[0]!.input.workspaceId}`
        await beginTransaction(holder)
        await holder.query('select pg_advisory_xact_lock(hashtext($1))', [key])
        const deadline = await pool.query("select current_setting('statement_timeout') as timeout")
        expect(deadline.rows[0]?.timeout).toBe('1s')
        let prepared = 0
        for (const runtime of runtimes) {
          const snapshot = runtime.locations.snapshot.bind(runtime.locations)
          snapshots.push(vi.spyOn(runtime.locations, 'snapshot').mockImplementation(async (...args) => {
            const location = await snapshot(...args)
            prepared++
            return location
          }))
        }
        const calls = starters.map(({ runtime, input }) => runtime.client.callTool({
          name: 'run_start', arguments: input,
        }))
        pending = calls
        await vi.waitFor(() => { expect(prepared).toBe(starters.length) }, { timeout: 5_000, interval: 20 })
        await waitForQueuedStarts(lockKind === 'runner' ? starters.length : 1)
        await commitTransaction(holder)
        const accepted = await Promise.all(calls)
        const ids: string[] = []
        for (const [index, response] of accepted.entries()) {
          expect(response.isError).not.toBe(true)
          const started = RunStartV3ResultSchema.parse(decodeMcpToolResult(response))
          expect(started).toMatchObject({ accepted: true, replayed: false })
          ids.push(started.run.id)
          await assertPersisted(starters[index]!, started.run.id)
        }
        expect(new Set(ids).size).toBe(4)

        const deniedRuntime = starters[0]!.runtime
        const reader = await deniedRuntime.access.issue({ name: 'Start read-only caller', audience: 'operator',
          expiresAt: new Date(Date.now() + 300_000), grants: [{
            actions: ['capabilities:read', 'runs:read', 'workspace_locations:read'],
            scope: { workspaceIds: [starters[0]!.input.workspaceId] },
          }] })
        const client = await deniedRuntime.connect(reader.token)
        const deniedInput = { ...starters[0]!.input, commandId: randomUUID() }
        const denied = await client.callTool({ name: 'run_start', arguments: deniedInput })
        expect(denied.isError).toBe(true)
        expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        const receipts = await database.pool.query(`select command_id from management_command_receipts
          where operation='run.start' and principal_id=$1 and command_id=$2`,
        [reader.principal.id, deniedInput.commandId])
        expect(receipts.rows).toEqual([])
        const denials = await database.pool.query(`select source,outcome from management_audit
          where principal_id=$1 and action='run_start'`, [reader.principal.id])
        expect(denials.rows).toContainEqual({ source: 'mcp', outcome: 'denied' })
        const runs = await database.pool.query('select id from runs where workflow_id=any($1::text[])',
          [starters.map(({ input }) => input.workflowId)])
        expect(runs.rows.map((row) => row.id).sort()).toEqual(ids.sort())
      } finally {
        await rollbackTransaction(holder)
        holder.release()
        await Promise.allSettled(pending)
        for (const snapshot of snapshots) snapshot.mockRestore()
        for (const runtime of runtimes.reverse()) await runtime.close()
        vi.restoreAllMocks()
      }
    }, 60_000)

  it('waits for the command lock and replays one persisted Run for concurrent retries', async () => {
    const runtimes: Runtime[] = []
    const holder = await database.pool.connect()
    let pending: Promise<unknown>[] = []
    try {
      const starter = (await createStarters(runtimes))[0]!
      await beginTransaction(holder)
      await holder.query('select pg_advisory_xact_lock(hashtext($1))',
        [`command:${starter.runtime.writer.principal.id}:run.start:${starter.input.commandId}`])
      const calls = Array.from({ length: 4 }, () => starter.runtime.client.callTool({
        name: 'run_start', arguments: starter.input,
      }))
      pending = calls
      await waitForQueuedStarts(calls.length)
      await commitTransaction(holder)
      const responses = await Promise.all(calls)
      const results = responses.map((response) => {
        expect(response.isError).not.toBe(true)
        return RunStartV3ResultSchema.parse(decodeMcpToolResult(response))
      })
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      expect(new Set(results.map((result) => result.run.id)).size).toBe(1)
      await assertPersisted(starter, results[0]!.run.id)
      const runs = await database.pool.query('select id from runs where workflow_id=$1', [starter.input.workflowId])
      expect(runs.rows).toEqual([{ id: results[0]!.run.id }])
    } finally {
      await rollbackTransaction(holder)
      holder.release()
      await Promise.allSettled(pending)
      for (const runtime of runtimes.reverse()) await runtime.close()
      vi.restoreAllMocks()
    }
  }, 60_000)

  it('returns RUN_START_BUSY over MCP and HTTP at the deadline, then accepts the same command on retry', async () => {
    const runtimes: Runtime[] = []
    const holder = await database.pool.connect()
    let pending: Promise<unknown>[] = []
    try {
      const starter = (await createStarters(runtimes))[0]!
      await beginTransaction(holder)
      await holder.query('select pg_advisory_xact_lock(hashtext($1))',
        [`command:${starter.runtime.writer.principal.id}:run.start:${starter.input.commandId}`])
      const remote = starter.runtime.client.callTool({ name: 'run_start', arguments: starter.input })
      const http = starter.runtime.app.inject({ method: 'POST',
        url: `/api/management/workspaces/${starter.input.workspaceId}/workflows/${starter.input.workflowId}/runs`,
        headers: { authorization: `Bearer ${starter.runtime.writer.token}` }, payload: starter.input })
      pending = [remote, http]
      const [mcpResponse, httpResponse] = await Promise.all([remote, http])
      expect(mcpResponse.isError).toBe(true)
      expect(decodeMcpToolResult(mcpResponse)).toMatchObject({ error: { code: 'RUN_START_BUSY' } })
      expect(httpResponse.statusCode).toBe(409)
      expect(httpResponse.json()).toMatchObject({ error: { code: 'RUN_START_BUSY' } })
      const runs = await database.pool.query('select id from runs where workflow_id=$1', [starter.input.workflowId])
      expect(runs.rows).toEqual([])
      const receipts = await database.pool.query(`select command_id from management_command_receipts
        where operation='run.start' and principal_id=$1 and command_id=$2`,
      [starter.runtime.writer.principal.id, starter.input.commandId])
      expect(receipts.rows).toEqual([])
      await commitTransaction(holder)
      const retry = await starter.runtime.client.callTool({ name: 'run_start', arguments: starter.input })
      expect(retry.isError).not.toBe(true)
      const accepted = RunStartV3ResultSchema.parse(decodeMcpToolResult(retry))
      expect(accepted).toMatchObject({ accepted: true, replayed: false })
      await assertPersisted(starter, accepted.run.id)
    } finally {
      await rollbackTransaction(holder)
      holder.release()
      await Promise.allSettled(pending)
      for (const runtime of runtimes.reverse()) await runtime.close()
      vi.restoreAllMocks()
    }
  }, 60_000)
})
