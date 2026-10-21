import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema, RunStartV3InputSchema,
  RunStartV3ResultSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { LOCAL_RUNNER_ID } from '../src/modules/workspaces/location.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { sch11Fixture, sch11DomainState } from './helpers/sch11Fixture.js'
import { deferred } from './helpers/deferred.js'

const maintenanceKey = 'foreman-code:production-maintenance'

async function starter() {
  const runtime = await currentOperatorIntegration({ insertRun: false,
    fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [] })
  try {
    const location = await runtime.client.callTool({ name: 'workspace_location_set', arguments: {
      workspaceId: runtime.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
      runnerId: LOCAL_RUNNER_ID, rootPath: runtime.db.directory,
    } })
    expect(location.isError).not.toBe(true)
    const savedResponse = await runtime.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save,
      arguments: await runtime.create() })
    expect(savedResponse.isError).not.toBe(true)
    const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedResponse)).value
    const input = RunStartV3InputSchema.parse({ workspaceId: saved.version.workspaceId,
      workflowId: saved.workflowId, workflowVersionId: saved.version.id, executionSemanticsVersion: 3,
      commandId: randomUUID(), expectedWorkflowRevision: saved.revision,
      expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: 2, input: { instruction: 'Maintenance admission regression' } })
    return { runtime, input, path: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs` }
  } catch (error) {
    await runtime.close()
    throw error
  }
}

it.skipIf(!postgresEnabled)('closes HTTP and MCP Start while retaining grants, command retries and persisted Run facts', async () => {
  const { runtime, input, path } = await starter()
  const holder = await runtime.db.pool.connect()
  try {
    await holder.query('select pg_advisory_lock(hashtext($1), hashtext(current_schema()))', [maintenanceKey])
    const headers = { authorization: `Bearer ${runtime.writer.token}` }
    const http = await runtime.app.inject({ method: 'POST', url: path, headers, payload: input })
    expect(http.statusCode).toBe(503)
    expect(http.json()).toMatchObject({ error: { code: 'RUN_START_MAINTENANCE' } })
    const mcp = await runtime.client.callTool({ name: 'run_start', arguments: input })
    expect(mcp.isError).toBe(true)
    expect(decodeMcpToolResult(mcp)).toMatchObject({ error: { code: 'RUN_START_MAINTENANCE' } })
    expect((await runtime.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
    expect((await runtime.db.pool.query(`select command_id from management_command_receipts
      where operation='run.start' and command_id=$1`, [input.commandId])).rows).toEqual([])
    const reader = await runtime.access.issue({ name: 'Read-only maintenance caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 300_000), grants: [{
        actions: ['capabilities:read', 'runs:read', 'workspace_locations:read'],
        scope: { workspaceIds: [input.workspaceId] },
      }] })
    const client = await runtime.connect(reader.token)
    const denied = await client.callTool({ name: 'run_start', arguments: input })
    expect(denied.isError).toBe(true)
    expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    await holder.query('select pg_advisory_unlock(hashtext($1), hashtext(current_schema()))', [maintenanceKey])
    const accepted = await runtime.client.callTool({ name: 'run_start', arguments: input })
    expect(accepted.isError).not.toBe(true)
    const result = RunStartV3ResultSchema.parse(decodeMcpToolResult(accepted))
    expect(result.replayed).toBe(false)
    const readback = await runtime.client.callTool({ name: 'run_get', arguments: {
      workspaceId: input.workspaceId, runId: result.run.id, detail: 'full',
    } })
    expect(readback.isError).not.toBe(true)
    expect(decodeMcpToolResult(readback)).toMatchObject({ run: {
      id: result.run.id, workflowVersionId: input.workflowVersionId, executionSemanticsVersion: 3,
    } })
    await holder.query('select pg_advisory_lock(hashtext($1), hashtext(current_schema()))', [maintenanceKey])
    const replay = await runtime.client.callTool({ name: 'run_start', arguments: input })
    expect(RunStartV3ResultSchema.parse(decodeMcpToolResult(replay))).toEqual({ ...result, replayed: true })
  } finally {
    await holder.query('select pg_advisory_unlock_all()')
    holder.release()
    await runtime.close()
  }
}, 60_000)

it.skipIf(!postgresEnabled)('rejects a Start that entered preparation before maintenance without changing its saved version', async () => {
  const { runtime, input } = await starter()
  const holder = await runtime.db.pool.connect()
  const entered = deferred()
  const release = deferred()
  const snapshot = runtime.locations.snapshot.bind(runtime.locations)
  const paused = vi.spyOn(runtime.locations, 'snapshot').mockImplementation(async (...args) => {
    const value = await snapshot(...args)
    entered.resolve()
    await release.promise
    return value
  })
  let pending: ReturnType<typeof runtime.client.callTool> | undefined
  try {
    const before = await runtime.db.pool.query('select record from workflow_versions where id=$1', [input.workflowVersionId])
    pending = runtime.client.callTool({ name: 'run_start', arguments: input })
    await entered.promise
    await holder.query('select pg_advisory_lock(hashtext($1), hashtext(current_schema()))', [maintenanceKey])
    release.resolve()
    const response = await pending
    expect(response.isError).toBe(true)
    expect(decodeMcpToolResult(response)).toMatchObject({ error: { code: 'RUN_START_MAINTENANCE' } })
    expect((await runtime.db.pool.query('select record from workflow_versions where id=$1', [input.workflowVersionId])).rows)
      .toEqual(before.rows)
    expect((await runtime.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
  } finally {
    release.resolve()
    if (pending) await pending
    paused.mockRestore()
    await holder.query('select pg_advisory_unlock_all()')
    holder.release()
    await runtime.close()
  }
}, 60_000)

it.skipIf(!postgresEnabled)('defers a due schedule during maintenance and admits its original occurrence afterward', async () => {
  const database = await agent3Database()
  const holder = await database.pool.connect()
  try {
    const f = await sch11Fixture(database)
    const saved = await f.save()
    f.time.now = saved.nextOccurrenceAt!
    const before = await sch11DomainState(f)
    await holder.query('select pg_advisory_lock(hashtext($1), hashtext(current_schema()))', [maintenanceKey])
    await expect(f.dispatcher().dispatch(saved)).rejects.toMatchObject({ code: 'RUN_START_MAINTENANCE' })
    expect(await sch11DomainState(f)).toEqual(before)
    expect(await f.countRuns()).toBe(0)
    await holder.query('select pg_advisory_unlock(hashtext($1), hashtext(current_schema()))', [maintenanceKey])
    await f.dispatcher().dispatch(saved)
    expect(await f.countRuns()).toBe(1)
    expect(await f.history()).toEqual([expect.objectContaining({ status: 'accepted', dueAt: saved.nextOccurrenceAt })])
  } finally {
    await holder.query('select pg_advisory_unlock_all()')
    holder.release()
    await database.close()
  }
}, 60_000)

it.skipIf(!postgresEnabled)('the installer holds admission closed across the idle check and releases it on abort', async () => {
  const { runtime, input } = await starter()
  const script = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
  const { withRunStartMaintenance, waitForIdleRuns } = await import(script)
  try {
    await expect(withRunStartMaintenance(runtime.db.pool, async (query: (text: string) => Promise<unknown>) => {
      await waitForIdleRuns({ query, timeoutMs: 0 })
      const response = await runtime.client.callTool({ name: 'run_start', arguments: input })
      expect(response.isError).toBe(true)
      expect(decodeMcpToolResult(response)).toMatchObject({ error: { code: 'RUN_START_MAINTENANCE' } })
      throw new Error('Installation aborted before stop')
    })).rejects.toThrow('Installation aborted before stop')
    const retry = await runtime.client.callTool({ name: 'run_start', arguments: input })
    expect(retry.isError).not.toBe(true)
    expect(RunStartV3ResultSchema.parse(decodeMcpToolResult(retry)).replayed).toBe(false)
  } finally {
    await runtime.close()
  }
}, 60_000)
