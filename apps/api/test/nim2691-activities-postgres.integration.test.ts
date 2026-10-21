import { describe, expect, it } from 'vitest'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { RunActivitiesService } from '../src/modules/runs/activities.js'
import { RUN_ACTIVITIES_BOUNDS_SQL, RUN_ACTIVITIES_PAGE_SQL } from '../src/modules/runs/activitiesSql.js'
import { publicRunActivity } from '../src/modules/runs/activityProjection.js'
import { RunHandoffReadService } from '../src/modules/runs/handoffRead.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema,
  CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  RunActivitiesPageSchema, RunHandoffsReadSchema } from '@foreman-code/contracts/wave25'
import { changeRunState, graphFixture, graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { writerFixture } from './eng04-writer-fixtures.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('NIM-2691 bounded Activities and handoff reads', () => {
  it('pins Run counters and paginates same-time facts across live overlap without disclosing source payloads', async () => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined } as Awaited<ReturnType<typeof currentDatabase>>
      const t = await graphFixture(db, { form: 'sequential', handoffs: true, qualifiedReads: true })
      const other = await graphFixture(db, { form: 'sequential', handoffs: true, qualifiedReads: true })
      try {
        await changeRunState(db, t, 'running')
        const foreignActivation = { scope: other.scope, activationId: 'foreign-activation',
          workflowNodeId: other.version.entryNodeId, lineageId: other.run.id,
          cause: { kind: 'entry' } }
        await pool.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,
          workflow_node_id,cause_kind,cause_id,state,record)
          values($1,$2,$3,$4,'entry',$2,'queued',$5::jsonb)`,
        [foreignActivation.activationId, other.run.id, other.version.id,
          other.version.entryNodeId, JSON.stringify(foreignActivation)])
        const handoffs = new RunHandoffReadService(pool), activities = new RunActivitiesService(pool)
        const current = await handoffs.read(t.writer.principal,
          { workspaceId: t.scope.workspaceId, runId: t.run.id })
        expect(current.policy).toBe('work')
        expect(current.connections).toHaveLength(1)
        expect(current.connections[0]).toMatchObject({ relationshipId: t.version.definition.edges[0]!.id,
          used: 0, limit: 3, remaining: 3 })
        const time = '2026-09-27T10:00:00.000Z'
        for (let index = 1; index <= 6; index++) await pool.query(`insert into run_activity
          (run_id,source,kind,occurred_at,payload) values($1,'backend','work_handoff_accepted',$2,$3::jsonb)`,
        [t.run.id, time, JSON.stringify({ requestId: `request-${index}`,
          activationId: foreignActivation.activationId,
          relationshipId: t.version.definition.edges[0]!.id, used: Math.min(index, 3), maximum: 3,
          credential: 'sk-activity-canary', command: 'never expose this command' })])
        const input = { workspaceId: t.scope.workspaceId, runId: t.run.id, limit: 2 }
        const initial = await activities.read(t.writer.principal, input)
        expect(initial.mode).toBe('initial')
        expect(initial.items.map((item) => item.kind)).toEqual(['work_request', 'work_request'])
        expect(initial.items.every((item) => item.refs.requestId === undefined
          && item.refs.activationId === undefined)).toBe(true)
        expect(initial.items[0]!.occurredAt).toBe(time)
        expect(BigInt(initial.items[0]!.sequence)<BigInt(initial.items[1]!.sequence)).toBe(true)
        expect(initial.olderCursor).toBeTruthy()
        expect(JSON.stringify(initial)).not.toContain('sk-activity-canary')
        expect(JSON.stringify(initial)).not.toContain('never expose this command')
        expect(JSON.stringify(initial)).not.toContain(foreignActivation.activationId)
        const earlierTime = '2026-09-26T09:00:00.000Z'
        await pool.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
          values($1,'backend','work_handoff_returned',$2,$3::jsonb)`,
        [t.run.id, earlierTime, JSON.stringify({ returnId: 'return-new', outcome: 'needs_changes' })])
        const older = await activities.read(t.writer.principal, { ...input, cursor: initial.olderCursor })
        expect(older.mode).toBe('older')
        expect(older.items.every((item) => BigInt(item.sequence)<BigInt(initial.items[0]!.sequence))).toBe(true)
        expect(older.items.every((item) => BigInt(item.sequence)<=BigInt(initial.highWater))).toBe(true)
        const newer = await activities.read(t.writer.principal, { ...input, cursor: initial.nextCursor })
        expect(newer.mode).toBe('newer')
        expect(newer.items[0]).toMatchObject({ kind: 'work_return', status: 'unknown',
          summary: 'Work return details unavailable' })
        expect(newer.items[0]?.refs.returnId).toBeUndefined()
        expect((await new RunActivitiesService(pool).read(t.writer.principal,
          { ...input, cursor: initial.nextCursor })).items.map((item) => item.id))
          .toEqual(newer.items.map((item) => item.id))
        expect(newer.items[0]!.occurredAt).toBe(earlierTime)
        expect(BigInt(newer.items[0]!.sequence)>BigInt(initial.highWater)).toBe(true)
        expect(new Set([...initial.items, ...older.items, ...newer.items].map((item) => item.id)).size)
          .toBe(initial.items.length + older.items.length + newer.items.length)
        await pool.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
          values($1,'harness','harness_output',$2,$3::jsonb)`,
        [t.run.id, earlierTime, JSON.stringify({ nativeEventSequence: 9,
          nativeEventType: 'provider.unavailable', secret: 'sk-native-canary' })])
        const unavailable = await activities.read(t.writer.principal, { ...input, cursor: newer.nextCursor })
        expect(unavailable.items[0]).toMatchObject({ kind: 'tool_log', status: 'recorded',
          summary: 'Native activity recorded; details unavailable' })
        expect(unavailable.items[0]?.actor).toBeUndefined()
        expect(JSON.stringify(unavailable)).not.toContain('sk-native-canary')
        const firstNode = agentWorkflowNode(t.version.definition.nodes[0])
        const safeTool = publicRunActivity({ sequence: '999999', source: 'harness',
          kind: 'harness_output', occurred_at: new Date(time), harness_execution_id: 'execution-tool',
          execution_node_id: firstNode.id, execution_agent_id: firstNode.agentId,
          execution_attempt: 1, work_activation_id: null, result_outcome: null,
          safe_payload: {}, native: { type: 'item.completed', itemType: 'commandExecution',
            itemStatus: 'completed', command: 'cat /private/file', output: 'sk-tool-canary' } },
        t.version, t.run.id, 'pending')
        expect(safeTool).toMatchObject({ kind: 'tool_action', status: 'completed',
          summary: 'Command action completed' })
        expect(JSON.stringify(safeTool)).not.toContain('sk-tool-canary')
        expect(JSON.stringify(safeTool)).not.toContain('/private/file')
        const failedWork = publicRunActivity({ sequence: '1000000', source: 'backend',
          kind: 'node_state_changed', occurred_at: new Date(time), harness_execution_id: 'execution-failed',
          execution_node_id: firstNode.id, execution_agent_id: firstNode.agentId,
          execution_attempt: 2, work_activation_id: null, result_outcome: 'failed',
          safe_payload: { state: 'completed',
            error: 'sk-error-body-canary' }, native: null }, t.version, t.run.id, 'pending')
        expect(failedWork).toMatchObject({ kind: 'agent_work', status: 'failed', severity: 'error',
          detail: 'Error details are available in Run inspection.', refs: { technicalAttempt: 2 } })
        expect(JSON.stringify(failedWork)).not.toContain('sk-error-body-canary')
        const decision = publicRunActivity({ sequence: '1000001', source: 'backend',
          kind: 'interaction_decided', occurred_at: new Date(time), harness_execution_id: null,
          execution_node_id: null, execution_agent_id: null, execution_attempt: null,
          work_activation_id: null, result_outcome: null,
          safe_payload: { interactionId: 'interaction-test', selectedSemantic: 'approve_once',
            error: 'sk-approval-canary' },
          native: null }, t.version, t.run.id, 'pending')
        expect(decision).toMatchObject({ kind: 'approval', status: 'recorded',
          summary: 'Approval granted; decision recorded' })
        expect(JSON.stringify(decision)).not.toContain('sk-approval-canary')
        await expect(activities.read(other.writer.principal,
          { workspaceId: other.scope.workspaceId, runId: other.run.id, cursor: initial.nextCursor }))
          .rejects.toMatchObject({ code: 'ACTIVITIES_CURSOR_SCOPE_CONFLICT' })
        const denied = await t.credential([{ actions: ['workflows:read'],
          scope: { workspaceIds: [t.scope.workspaceId] } }])
        await expect(activities.read(denied.principal, input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
        await expect(handoffs.read(denied.principal,
          { workspaceId: t.scope.workspaceId, runId: t.run.id })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
        await pool.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
          select $1,'backend','work_result_accepted',$2,'{}'::jsonb from generate_series(1,1001)`,
        [t.run.id, time])
        expect((await pool.query<{ indexname: string }>(`select indexname from pg_indexes
          where tablename='run_activity' and indexname='run_activity_run_idx'`)).rows).toHaveLength(1)
        const boundsPlan = (await pool.query<{ 'QUERY PLAN': unknown }>(
          `explain (format json) ${RUN_ACTIVITIES_BOUNDS_SQL}`, [t.run.id])).rows[0]?.['QUERY PLAN']
        const pagePlan = (await pool.query<{ 'QUERY PLAN': unknown }>(
          `explain (format json) ${RUN_ACTIVITIES_PAGE_SQL.replace('__COMPARATOR__', '>')
            .replace('__ORDER__', 'asc')}`,
          [t.run.id, initial.highWater, newer.highWater, '0', 3])).rows[0]?.['QUERY PLAN']
        expect(JSON.stringify(boundsPlan)).toContain('Limit')
        expect(JSON.stringify(pagePlan)).toContain('Limit')
        await expect(activities.read(t.writer.principal, { ...input, cursor: initial.nextCursor }))
          .rejects.toMatchObject({ code: 'ACTIVITIES_CURSOR_EXPIRED', status: 410 })
      } finally { await other.app.close(); await t.app.close() }
    })
  }, 120000)

  it('serves the same scoped reads over authenticated HTTP and Operator MCP, including denied and revoked callers', async () => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined } as Awaited<ReturnType<typeof currentDatabase>>
      const t = await graphFixture(db, { form: 'sequential', handoffs: true, qualifiedReads: true })
      const runs = new RunManagementService(pool, t.commands, {} as never, {} as never, {} as never)
      const app = buildApp({ readiness: { database: { ping: async () => { await pool.query('select 1') } },
        checkpoints: { ping: async () => undefined } },
        operator: { access: t.access, services: { commands: t.commands, workflows: t.workflows,
          runs } as unknown as OperatorServices } })
      try {
        await app.ready()
        const path = `/api/management/workspaces/${t.scope.workspaceId}/runs/${t.run.id}`
        const args = { workspaceId: t.scope.workspaceId, runId: t.run.id }
        const listToolNames = async (token: string) => {
          const names: string[] = []
          const cursors = new Set<string>()
          let cursor: string | undefined
          do {
            const listed = await graphRpc(app, token, 'tools/list', cursor ? { cursor } : {})
            expect(listed.error).toBeUndefined()
            expect(listed.result?.tools).toBeDefined()
            names.push(...listed.result!.tools!.map(tool => tool.name))
            cursor = listed.result?.nextCursor
            if (cursor) {
              expect(cursors.has(cursor)).toBe(false)
              cursors.add(cursor)
            }
          } while (cursor)
          return names
        }
        const names = await listToolNames(t.writer.token)
        expect(names).toContain('run_handoffs_get_v1')
        expect(names).toContain('run_activities_get_v1')
        const handoffsHttp = await app.inject({ method: 'GET', url: `${path}/handoffs`,
          headers: graphHeaders(t.writer.token) })
        expect(handoffsHttp.statusCode, handoffsHttp.body).toBe(200)
        const handoffs = RunHandoffsReadSchema.parse(handoffsHttp.json())
        expect(handoffs.connections[0]).toMatchObject({ used: 0, limit: 3, remaining: 3 })
        const handoffsMcp = await graphRpc(app, t.writer.token, 'tools/call', {
          name: 'run_handoffs_get_v1', arguments: args })
        expect(handoffsMcp.result?.isError).not.toBe(true)
        expect(RunHandoffsReadSchema.parse(graphRpcValue(handoffsMcp.result))).toEqual(handoffs)
        const activityHttp = await app.inject({ method: 'GET', url: `${path}/activities?limit=10`,
          headers: graphHeaders(t.writer.token) })
        expect(activityHttp.statusCode, activityHttp.body).toBe(200)
        const page = RunActivitiesPageSchema.parse(activityHttp.json())
        const activityMcp = await graphRpc(app, t.writer.token, 'tools/call', {
          name: 'run_activities_get_v1', arguments: { ...args, limit: 10 } })
        expect(activityMcp.result?.isError).not.toBe(true)
        expect(RunActivitiesPageSchema.parse(graphRpcValue(activityMcp.result))).toEqual(page)
        const denied = await t.credential([{ actions: ['workflows:read'],
          scope: { workspaceIds: [t.scope.workspaceId] } }])
        const hidden = await listToolNames(denied.token)
        expect(hidden).not.toContain('run_handoffs_get_v1')
        expect(hidden).not.toContain('run_activities_get_v1')
        const before = (await pool.query('select count(*)::integer as n from run_activity where run_id=$1',
          [t.run.id])).rows[0]?.n
        const deniedHttp = await app.inject({ method: 'GET', url: `${path}/activities`,
          headers: graphHeaders(denied.token) })
        expect(deniedHttp.statusCode).toBe(403)
        const deniedMcp = await graphRpc(app, denied.token, 'tools/call', {
          name: 'run_handoffs_get_v1', arguments: args })
        expect(deniedMcp.result?.isError).toBe(true)
        expect((await pool.query('select count(*)::integer as n from run_activity where run_id=$1',
          [t.run.id])).rows[0]?.n).toBe(before)
        const reader = await t.credential([{ actions: ['runs:read'],
          scope: { workspaceIds: [t.scope.workspaceId] } }])
        expect((await app.inject({ method: 'GET', url: `${path}/activities`,
          headers: graphHeaders(reader.token) })).statusCode).toBe(200)
        expect((await app.inject({ method: 'GET', url: `${path}/handoffs`,
          headers: graphHeaders(reader.token) })).statusCode).toBe(403)
        const readerTools = await listToolNames(reader.token)
        expect(readerTools).toContain('run_activities_get_v1')
        expect(readerTools).not.toContain('run_handoffs_get_v1')
        await t.access.revoke(reader.principal.id)
        expect((await app.inject({ method: 'GET', url: `${path}/activities?cursor=${encodeURIComponent(page.nextCursor)}`,
          headers: graphHeaders(reader.token) })).statusCode).not.toBe(200)
        const revokedMcp = await graphRpc(app, reader.token, 'tools/call', {
          name: 'run_activities_get_v1', arguments: { ...args, cursor: page.nextCursor } })
        expect(revokedMcp.status === 200 && revokedMcp.result?.isError !== true).toBe(false)
        await pool.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
          select $1,'backend','work_result_accepted',clock_timestamp(),'{}'::jsonb
          from generate_series(1,1001)`, [t.run.id])
        const expiredHttp = await app.inject({ method: 'GET',
          url: `${path}/activities?cursor=${encodeURIComponent(page.nextCursor)}`,
          headers: graphHeaders(t.writer.token) })
        expect(expiredHttp.statusCode).toBe(410)
        expect(expiredHttp.json()).toMatchObject({ error: { code: 'ACTIVITIES_CURSOR_EXPIRED' } })
        const expiredMcp = await graphRpc(app, t.writer.token, 'tools/call', {
          name: 'run_activities_get_v1', arguments: { ...args, cursor: page.nextCursor } })
        expect(expiredMcp.result?.isError).toBe(true)
      } finally { await app.close(); await t.app.close() }
    })
  }, 120000)

  it('saves a configured connection limit through Operator MCP and reads the immutable version through HTTP', async () => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined } as Awaited<ReturnType<typeof currentDatabase>>
      const t = await writerFixture(db)
      try {
        const input = CurrentWorkflowSaveInputSchema.parse({ ...t.input, graph: {
          ...t.input.graph, handoffs: { contractVersion: 1 },
          edges: t.input.graph.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 3 })),
        } })
        const savedMcp = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
        expect(savedMcp.result?.isError).not.toBe(true)
        const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(savedMcp.result))
        const read = await t.app.inject({ method: 'GET', url: t.url,
          headers: graphHeaders(t.writer.token) })
        expect(read.statusCode, read.body).toBe(200)
        const persisted = CurrentWorkflowReadResultSchema.parse(read.json())
        expect(persisted.version.id).toBe(saved.value.version.id)
        expect(persisted.version.definition.edges[0]?.maxWorkHandoffsPerRun).toBe(3)
        const denied = await t.credential([{ actions: ['workflows:read'],
          scope: { workspaceIds: [input.workspaceId] } }])
        const before = (await pool.query<{ n: number }>(
          'select count(*)::integer as n from workflow_versions where workflow_id=$1',
          [input.workflowId])).rows[0]?.n
        const refused = await t.call(CURRENT_WORKFLOW_TOOLS.save,
          { ...input, commandId: 'nim2691-denied-save' }, denied.token)
        expect(refused.result?.isError).toBe(true)
        expect((await pool.query<{ n: number }>(
          'select count(*)::integer as n from workflow_versions where workflow_id=$1',
          [input.workflowId])).rows[0]?.n).toBe(before)
      } finally { await t.app.close() }
    })
  }, 120000)

  it('does not reinterpret an unmarked saved Run as having unlimited handoffs', async () => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined } as Awaited<ReturnType<typeof currentDatabase>>
      const t = await graphFixture(db, { form: 'sequential', qualifiedReads: true })
      try {
        const read = await new RunHandoffReadService(pool).read(t.writer.principal,
          { workspaceId: t.scope.workspaceId, runId: t.run.id })
        expect(read).toMatchObject({ policy: 'not_configured',
          connections: [], routes: [], notices: [], unresolved: [], directionWait: false })
      } finally { await t.app.close() }
    })
  }, 120000)
})
