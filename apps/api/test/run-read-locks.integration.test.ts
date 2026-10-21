import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { RUN_INSPECTION_TOOLS } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { RepeatRepositoryFactory } from '../src/modules/runs/repeatRepositoryHost.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

async function fixture() {
  const db = await currentDatabase()
  try {
    const graph = await graphFixture(db, { form: 'single', qualifiedReads: true })
    const readPool = new pg.Pool({ ...db.pool.options,
      options: `-c search_path=${db.schema} -c statement_timeout=1000 -c lock_timeout=0` })
    const locations = new WorkspaceLocationService(db.pool, graph.commands)
    const runs = new RunManagementService(readPool, graph.commands, {} as never, {} as never, locations)
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: graph.access, services: {
        commands: graph.commands, workflows: graph.workflows, runs,
      } as never } })
    return { db, graph, readPool, runs, app, locations, async close() {
      await app.close()
      await graph.app.close()
      await readPool.end()
      await db.close()
    } }
  } catch (error) {
    await db.close()
    throw error
  }
}

async function promptly<T>(work: Promise<T>): Promise<T> {
  let settled = false
  const result = work.then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
  await expect.poll(() => settled, { timeout: 1500 }).toBe(true)
  const outcome = await result
  if ('error' in outcome) throw outcome.error
  return outcome.value
}

describe('authenticated Run reads during concurrent writes', () => {
  it('reads committed detail, events and activities while Run, head, execution, pins and grants are locked', async () => {
    const f = await fixture()
    const { run, version } = f.graph
    const args = { workspaceId: run.workspaceId, runId: run.id }
    const caller = await f.graph.credential([{ actions: ['runs:read'], scope: { runIds: [run.id] } }])
    const denied = await f.graph.credential([{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }])
    const owner = await RunOwnership.acquire(f.db.pool, run.id, () => {})
    if (!owner) {
      await f.close()
      throw new Error('The fixture Run could not be owned')
    }
    const blocker = await f.db.pool.connect()
    try {
      const factory = new RepeatRepositoryFactory(f.locations, f.db.directory,
        createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify).services)
      const store = factory.forOwner(owner, version)
      const node = agentWorkflowNode(version.definition.nodes[0])
      const admitted = await store.admit({ nodeId: node.id, occurrence: null }, () => HarnessExecutionSchema.parse({
        id: `execution-${randomUUID()}`, runId: run.id, workflowNodeId: node.id, agentId: node.agentId,
        agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
        attempt: 1, input: {}, state: 'queued', createdAt: run.createdAt,
      }))
      if (admitted.kind !== 'admitted') throw new Error('The fixture execution was not admitted')
      const baseline = await f.runs.get(caller.principal, run.workspaceId, run.id)
      await blocker.query('begin')
      await blocker.query('update runs set stop_requested_at=clock_timestamp() where id=$1', [run.id])
      await blocker.query('select run_id from run_graph_heads where run_id=$1 for update', [run.id])
      await blocker.query('select id from harness_executions where id=$1 for update', [admitted.execution.id])
      await blocker.query('select id from workflow_versions where id=$1 for update', [version.id])
      await blocker.query('select id from agent_configuration_versions where id=any($1::text[]) for update',
        [Object.values(version.agentConfigurationVersionIds)])
      await blocker.query('select id from management_principals where id=$1 for update', [caller.principal.id])

      const detail = await promptly(graphRpc(f.app, caller.token, 'tools/call', {
        name: 'run_get', arguments: { ...args, detail: 'full' },
      }))
      expect(detail.result?.isError, JSON.stringify(detail)).not.toBe(true)
      expect(graphRpcValue(detail.result)).toEqual(baseline)
      for (const name of ['run_events_list', 'run_activities_get_v1'] as const) {
        const read = await promptly(graphRpc(f.app, caller.token, 'tools/call', {
          name, arguments: { ...args, limit: 10 },
        }))
        expect(read.result?.isError, JSON.stringify(read)).not.toBe(true)
        expect(graphRpcValue(read.result)).toHaveProperty('items')
      }
      const http = await promptly(f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${run.workspaceId}/runs/${run.id}`, headers: graphHeaders(caller.token) }))
      expect(http.statusCode, http.body).toBe(200)
      expect(http.json()).toEqual(baseline)
      const forbidden = await promptly(graphRpc(f.app, denied.token, 'tools/call', {
        name: 'run_get', arguments: args,
      }))
      expect(graphRpcValue(forbidden.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect((await f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${run.workspaceId}/runs/${run.id}`,
        headers: graphHeaders(denied.token) })).statusCode).toBe(403)
      expect((await promptly(store.readExecution(admitted.execution.id))).execution).toEqual(admitted.execution)
      await blocker.query('commit')
      const persisted = await graphRpc(f.app, caller.token, 'tools/call', {
        name: RUN_INSPECTION_TOOLS.record, arguments: args,
      })
      expect(graphRpcValue(persisted.result)).toMatchObject({ stopRequested: true })
      await f.graph.access.revoke(caller.principal.id)
      await expect(f.runs.get(caller.principal, run.workspaceId, run.id)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally {
      await blocker.query('rollback')
      blocker.release()
      await owner.release()
      await f.close()
    }
  }, 90000)

  it('returns retryable database deadlines through authenticated MCP and HTTP', async () => {
    const f = await fixture()
    const { run } = f.graph
    const args = { workspaceId: run.workspaceId, runId: run.id }
    const blocker = await f.db.pool.connect()
    try {
      await blocker.query('begin')
      await blocker.query('lock table runs in access exclusive mode')
      for (const name of ['run_get', 'run_events_list', 'run_activities_get_v1'] as const) {
        const result = await graphRpc(f.app, f.graph.writer.token, 'tools/call', {
          name, arguments: { ...args, ...(name === 'run_get' ? {} : { limit: 10 }) },
        })
        expect(result.result?.isError).toBe(true)
        expect(graphRpcValue(result.result)).toMatchObject({ error: {
          code: 'DATABASE_READ_TIMEOUT', details: { retryable: true, sqlState: '57014' },
        } })
      }
      const inspection = await graphRpc(f.app, f.graph.writer.token, 'tools/call', {
        name: RUN_INSPECTION_TOOLS.record, arguments: args,
      })
      expect(inspection.result?.isError).toBe(true)
      expect(graphRpcValue(inspection.result)).toMatchObject({ error: {
        code: 'RUN_INSPECTION_UNAVAILABLE', details: { retryable: true, sqlState: '57014' },
      } })
      const response = await f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${run.workspaceId}/runs/${run.id}`,
        headers: graphHeaders(f.graph.writer.token) })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ error: {
        code: 'DATABASE_READ_TIMEOUT', details: { retryable: true, sqlState: '57014' },
      } })
    } finally {
      await blocker.query('rollback')
      blocker.release()
      await f.close()
    }
  }, 90000)
})
