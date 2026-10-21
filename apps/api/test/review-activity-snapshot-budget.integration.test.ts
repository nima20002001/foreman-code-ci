import type pg from 'pg'
import { expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { buildApp } from '../src/app.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { withCurrentRunRead } from '../src/modules/runs/currentRead.js'
import { readRunActivitySnapshot } from '../src/modules/runs/activitySnapshot.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { RunActivitiesPageSchema } from '@foreman-code/contracts/wave25'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'

it.skipIf(process.env.NIM2691_POSTGRES !== '1').each(['running', 'completed'])('pages public history independently of 1000 %s native items over HTTP/MCP', async (status) => {
  await nim2691TaskDatabase(async (pool, directory) => {
    await applyApplicationMigrations(pool)
    const db = { pool, directory, schema: 'public', close: async () => {} } as Awaited<ReturnType<typeof currentDatabase>>
    const t = await graphFixture(db, { form: 'sequential', qualifiedReads: true })
    const runs = new RunManagementService(pool, t.commands, {} as never, {} as never, {} as never)
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: t.access, services: { commands: t.commands, workflows: t.workflows, runs } as never } })
    try {
      const node = agentWorkflowNode(t.version.definition.nodes[0])
      const executionId = 'budget-execution'
      await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
        values($1,$2,$3,$4,1,$5::jsonb)`, [executionId, t.run.id, node.id, node.agentId,
        JSON.stringify({ id: executionId, runId: t.run.id, workflowNodeId: node.id, agentId: node.agentId, attempt: 1,
          state: 'running', input: {}, createdAt: '2026-10-02T00:00:00.000Z', nativeSessionId: 'budget-session',
          agentConfigurationVersionId: t.version.agentConfigurationVersionIds[node.agentId] })])
      await pool.query(`insert into harness_native_events(execution_id,sequence,record)
        select $1,n,jsonb_build_object('type','item.started','occurredAt','2026-10-02T00:00:00.000Z',
          'payload',jsonb_build_object('threadId','budget-session','item',jsonb_build_object('id','tool-'||n,'type','commandExecution','status',$2::text)))
        from generate_series(1,1000) n`, [executionId, status])
      await pool.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
        select $1,'backend','work_result_accepted',now(),'{}'::jsonb from generate_series(1,3)`, [t.run.id])
      const args = { workspaceId: t.scope.workspaceId, runId: t.run.id, limit: 1 }
      const url = `/api/management/workspaces/${args.workspaceId}/runs/${args.runId}/activities`
      const http = await app.inject({ method: 'GET', url: `${url}?limit=1`, headers: graphHeaders(t.writer.token) })
      expect(http.statusCode, http.body).toBe(200)
      const first = RunActivitiesPageSchema.parse(http.json())
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(128 * 1024)
      expect(first).not.toHaveProperty('activitySnapshot')
      const snapshot = await withCurrentRunRead(pool, t.writer.principal, args.workspaceId, args.runId,
        'runs:read', (sql, { version }) => readRunActivitySnapshot(sql as unknown as Pick<pg.PoolClient, 'query'>, {
          workspaceId: args.workspaceId, workflowId: t.scope.workflowId,
          runId: args.runId, workflowVersionId: t.version.id,
        }, version))
      const tools = snapshot.activities.filter((item) => item.kind === 'tool')
      expect(tools).toHaveLength(1000)
      expect(tools.at(-1)?.native?.itemId).toBe('tool-1000')
      expect(tools.every((item) => item.status === status)).toBe(true)
      expect(snapshot.active.filter((item) => item.ref.kind === 'tool'))
        .toHaveLength(status === 'running' ? 1000 : 0)
      expect(first.items).toHaveLength(1)
      const mcp = await graphRpc(app, t.writer.token, 'tools/call', { name: 'run_activities_get_v1', arguments: args })
      expect(mcp.result?.isError).not.toBe(true)
      expect(RunActivitiesPageSchema.parse(graphRpcValue(mcp.result))).toEqual(first)
      for (const cursor of [first.olderCursor!, first.nextCursor]) {
        const next = await graphRpc(app, t.writer.token, 'tools/call', {
          name: 'run_activities_get_v1', arguments: { ...args, cursor } })
        expect(next.result?.isError).not.toBe(true)
        expect(Buffer.byteLength(JSON.stringify(graphRpcValue(next.result)))).toBeLessThanOrEqual(128 * 1024)
      }
      const denied = await t.credential([{ actions: ['workflows:read'], scope: { workspaceIds: [args.workspaceId] } }])
      const blocked = await graphRpc(app, denied.token, 'tools/call', { name: 'run_activities_get_v1', arguments: args })
      expect(blocked.error || blocked.result?.isError).toBeTruthy()
      expect((await pool.query('select count(*)::integer as n from harness_native_events where execution_id=$1', [executionId])).rows[0]!.n).toBe(1000)
    } finally { await app.close(); await t.app.close() }
  })
}, 120000)
