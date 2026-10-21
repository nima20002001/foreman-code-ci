import {
  decodeMcpToolResult, OperatorCompactCapabilitiesSchema, OperatorToolSchemaResultSchema,
} from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  AcceptedRepeatStartV1Schema, CurrentOperatorCapabilitiesSchema, CurrentWorkflowSaveResultSchema, CURRENT_WORKFLOW_TOOLS,
  makeCurrentWorkflowFixture, RunStartV3ResultSchema,
} from '@foreman-code/contracts/wave25'
import { RunBoardSnapshotGetResultSchema, RunDropdownPageSchema } from '@foreman-code/contracts/run-snapshots'
import { RUN_HISTORY_TOOLS, type RunHistoryToolName } from '../src/mcp/operator/tools/runHistory.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { encodeRunHistoryCursor } from '../src/modules/runs/historyCursor.js'
import { LOCAL_RUNNER_ID } from '../src/modules/workspaces/location.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { waitForSuccessfulRunCleanup } from './helpers/runSettlement.testSupport.js'

// The task explicitly leaves the application registry to the integrator. In
// THIS test module only, apply the real pending SQL after real base migrations,
// before the existing fixture calls common Start. No schema/SQL behavior is
// mocked, and this also works once 270205 is registered in migrations.ts.
vi.mock('../src/infrastructure/migrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infrastructure/migrations.js')>()
  const { runSnapshotMigration } = await import('../src/infrastructure/runSnapshotMigration.js')
  const { withTransaction } = await import('../src/infrastructure/transaction.js')
  return { ...actual, applyApplicationMigrations: async (...args: Parameters<typeof actual.applyApplicationMigrations>) => {
    await actual.applyApplicationMigrations(...args)
    await withTransaction(args[0], async client => {
      const row = (await client.query<{ relation: string | null }>(
        "select to_regclass(current_schema() || '.run_board_snapshots')::text as relation")).rows[0]!
      if (!row.relation) await client.query(runSnapshotMigration.sql)
    })
  } }
})

type Fixture = Awaited<ReturnType<typeof currentOperatorIntegration>>
type Client = Fixture['client']
function value(result: { isError?: boolean | undefined; structuredContent?: unknown }): unknown {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  expect(decodeMcpToolResult(result)).toBeDefined()
  return decodeMcpToolResult(result)
}
function errorCode(result: unknown): string {
  const response = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
  expect(response.isError).toBe(true)
  return (JSON.parse(response.content!.find((item) => item.type === 'text')!.text!) as { error: { code: string } }).error.code
}
const scope = (f: Fixture) => ({ workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId })
const snapshotScope = (f: Fixture, runId = f.f.run.id) => ({ ...scope(f), runId })
function url(name: RunHistoryToolName, input: Record<string, unknown>): string {
  const { workspaceId, workflowId, runId, ...query } = input
  const base = `/api/management/workspaces/${encodeURIComponent(String(workspaceId))}/workflows/${encodeURIComponent(String(workflowId))}/runs`
  const path = name === RUN_HISTORY_TOOLS.list ? `${base}/summaries` : `${base}/${encodeURIComponent(String(runId))}/snapshot`
  const parameters = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
  return path + (parameters.size ? `?${parameters}` : '')
}
async function parity(f: Fixture, client: Client, token: string, name: RunHistoryToolName, input: Record<string, unknown>) {
  const http = await f.app.inject({ method: 'GET', url: url(name, input), headers: { authorization: `Bearer ${token}` } })
  expect(http.statusCode, http.body).toBe(200)
  expect(http.headers['cache-control']).toBe('private, no-store')
  expect(http.headers.vary).toContain('Authorization')
  const result = value(await client.callTool({ name, arguments: input }))
  expect(http.json()).toEqual(result)
  return result
}
async function denied(f: Fixture, client: Client, token: string, name: RunHistoryToolName,
  input: Record<string, unknown>, status: number, code: string) {
  const http = await f.app.inject({ method: 'GET', url: url(name, input), headers: { authorization: `Bearer ${token}` } })
  expect(http.statusCode, http.body).toBe(status)
  expect(http.json()).toMatchObject({ error: { code } })
  expect(errorCode(await client.callTool({ name, arguments: input }))).toBe(code)
}
async function reader(f: Fixture, grants?: ManagementPrincipal['grants']) {
  const issued = await f.access.issue({ name: 'SCH-05 read-only history', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
    grants: grants ?? [{ actions: ['capabilities:read'], scope: {} },
      { actions: ['runs:read'], scope: { workspaceIds: [scope(f).workspaceId], workflowIds: [scope(f).workflowId] } }] })
  return { ...issued, client: await f.connect(issued.token) }
}
async function terminal(f: Fixture, runId = f.f.run.id) {
  await waitForSuccessfulRunCleanup({ pool: f.db.pool, runId, timeoutMs: 20000,
    readRecord: () => f.services.runs.inspection.record(f.writer.principal, { workspaceId: scope(f).workspaceId, runId }) })
}
async function nativeSessions(f: Fixture) {
  return (await f.db.pool.query(`select s.execution_id,s.reference,s.workflow_finalized_at
    from execution_native_sessions s join harness_executions e on e.id=s.execution_id
    where e.run_id=$1 order by s.execution_id`, [f.f.run.id])).rows
}
async function acceptedAgain(f: Fixture) {
  const version = f.f.version, run = { ...f.f.run, id: `run-${randomUUID()}`, createdAt: new Date().toISOString() }
  const revision = Number((await f.db.pool.query<{ revision: string }>(
    'select revision::text from workflows where id=$1', [run.workflowId])).rows[0]!.revision)
  return AcceptedRepeatStartV1Schema.parse({ run, snapshot: {
    request: { ...scope(f), workflowVersionId: version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
      expectedWorkflowRevision: revision, expectedLocationRevision: run.executionLocation!.locationRevision,
      expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, input: run.input },
    authorizationPrincipalId: run.authorizationPrincipalId, executable: { version, configurations: f.f.configurations },
    workflow: { id: run.workflowId, workspaceId: run.workspaceId, revision, currentVersionId: version.id,
      archived: false, definition: version.definition },
    workspace: { id: run.workspaceId, archived: false, location: run.executionLocation }, draft: null,
  } })
}
// Raw legacy rows intentionally have no Board capture or canonical Run graph.
// That is exactly the read-only backward-compatibility case, not a new Start.
async function legacy(f: Fixture, id: string, createdAt: string, trigger: 'manual' | 'schedule' | 'on_event' = 'manual', executionSemanticsVersion: 1 | 3 = 3) {
  const run = { ...f.f.run, id, createdAt, executionSemanticsVersion, executionCondition: { kind: trigger } }
  await f.db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record,created_at)
    values($1,$2,$3,$4,'queued',$5::jsonb,$6::timestamptz)`,
  [id, run.workspaceId, run.workflowId, run.workflowVersionId, JSON.stringify(run), createdAt])
  return run
}

afterEach(() => vi.restoreAllMocks())
// Actual PostgreSQL migrations, common Start G1 and publisher, typed Save,
// production service composition and authenticated HTTP/MCP. Existing native
// provider/runner qualification fixtures remain synthetic; no paid model runs.
describe.skipIf(!postgresEnabled)('SCH-05 immutable Board/history authenticated PostgreSQL parity', () => {
  it('Run A retains Y/layout/edges/sessions after a real Save removes Y; public Start Run B has no Y', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
    const y = fixture.version.definition.nodes[1]!
    y.name = 'Agent Y'; y.position = { x: -34.25, y: 712 }; y.width = 342; y.height = 168
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [] })
    try {
      await f.engine.start(f.f.run.id); await terminal(f)
      const r = await reader(f), args = snapshotScope(f)
      const before = RunBoardSnapshotGetResultSchema.parse(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, args))
      expect(before.snapshot).toMatchObject({ kind: 'available', workflowVersionId: f.f.version.id })
      if (before.snapshot.kind !== 'available') throw new Error('Run A must be captured')
      expect(before.snapshot.nodes.find((node) => node.id === y.id)).toMatchObject({ name: 'Agent Y', agentId: y.agentId,
        agentConfigurationVersionId: f.f.version.agentConfigurationVersionIds[y.agentId],
        position: { x: -34.25, y: 712 }, size: { width: 342, height: 168 } })
      const stored = (await f.db.pool.query<{ record: unknown }>('select record from run_board_snapshots where run_id=$1', [args.runId])).rows[0]!.record
      expect(before.snapshot).toEqual(stored)
      const sessions = await nativeSessions(f)
      expect(sessions.length).toBeGreaterThan(0)
      const runBefore = (await f.db.pool.query('select * from runs where id=$1', [args.runId])).rows

      // Qualify the fixture's existing real directory before a public new Start.
      const location = await f.locations.set(f.writer.principal, 'http', { workspaceId: args.workspaceId,
        commandId: randomUUID(), expectedLocationRevision: 1, runnerId: LOCAL_RUNNER_ID, rootPath: f.db.directory })
      const graph = structuredClone(f.f.version.definition)
      graph.nodes = graph.nodes.filter((node) => node.id !== y.id)
      graph.edges = graph.edges.filter((edge) => edge.source !== y.id && edge.target !== y.id)
      graph.executionPolicy = { maxParallelism: 1, maxNodeExecutions: graph.nodes.length }
      if (graph.requiredAgentCount !== undefined) graph.requiredAgentCount = graph.nodes.length
      const pins = Object.fromEntries(graph.nodes.map((node) => [node.agentId, f.f.version.agentConfigurationVersionIds[node.agentId]!]))
      const revision = Number((await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [args.workflowId])).rows[0]!.revision)
      const saved = CurrentWorkflowSaveResultSchema.parse(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: {
        workspaceId: args.workspaceId, workflowId: args.workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: revision, expectedWorkflowVersionId: f.f.version.id,
        expectedAgentConfigurationVersionIds: pins, graph,
      } }))).value
      expect(saved.version.id).not.toBe(f.f.version.id)
      expect((await f.db.pool.query('select id from runs where workflow_id=$1', [args.workflowId])).rows).toHaveLength(1)
      expect(await nativeSessions(f)).toEqual(sessions)
      expect((await f.db.pool.query('select * from runs where id=$1', [args.runId])).rows).toEqual(runBefore)
      expect(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, args)).toEqual(before)

      // Geometry-only Save intentionally keeps the executable version ID. A
      // later Run must capture this locked saved layout, not that version's old
      // geometry. Run A must remain unchanged after this second Save too.
      const layoutGraph = structuredClone(saved.version.definition)
      layoutGraph.nodes[0]!.position = { x: 909, y: -33 }; layoutGraph.nodes[0]!.width = 480
      const layoutSaved = CurrentWorkflowSaveResultSchema.parse(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: {
        workspaceId: args.workspaceId, workflowId: args.workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: saved.revision, expectedWorkflowVersionId: saved.version.id,
        expectedAgentConfigurationVersionIds: pins,
        graph: layoutGraph,
      } }))).value
      expect(layoutSaved.version.id).toBe(saved.version.id)
      expect(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, args)).toEqual(before)

      // Metadata/archive updates cannot rewrite captured names or cascade history.
      await f.db.pool.query("update agents set record=jsonb_set(record,'{name}','\"Renamed current Y\"'), archived_at=now() where id=$1", [y.agentId])
      expect(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, args)).toEqual(before)
      await expect(f.db.pool.query('delete from agents where id=$1', [y.agentId])).rejects.toThrow()
      expect(await nativeSessions(f)).toEqual(sessions)
      const startInput = { workspaceId: args.workspaceId, workflowId: args.workflowId, workflowVersionId: saved.version.id,
        executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: layoutSaved.revision,
        expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
        expectedLocationRevision: location.value.locationRevision, input: {} }
      const started = RunStartV3ResultSchema.parse(value(await f.client.callTool({ name: 'run_start', arguments: startInput })))
      await terminal(f, started.run.id)
      const after = RunBoardSnapshotGetResultSchema.parse(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, snapshotScope(f, started.run.id)))
      if (after.snapshot.kind !== 'available') throw new Error('Run B must be captured')
      expect(after.snapshot.nodes.some((node) => {
        if (node.kind === 'job') throw new Error('Historical Agent snapshot fixture requires Agent nodes')
        return node.id === y.id || node.agentId === y.agentId
      })).toBe(false)
      expect(after.snapshot.edges.some((edge) => edge.source === y.id || edge.target === y.id)).toBe(false)
      expect(after.snapshot.workflowVersionId).toBe(saved.version.id)
      expect(after.snapshot.nodes[0]).toMatchObject({ position: { x: 909, y: -33 }, size: { width: 480 } })
      expect(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, args)).toEqual(before)
      expect(await nativeSessions(f)).toEqual(sessions)
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 60000)

  it('discovers read tools, denies absent/wrong/revoked grants and forged IDs, and returns explicit legacy-unavailable', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const r = await reader(f), args = snapshotScope(f)
      const discovery = (await r.client.listTools()).tools
      for (const name of Object.values(RUN_HISTORY_TOOLS)) {
        const tool = discovery.find((item) => item.name === name)
        expect(tool?.name).toBe(name)
        expect(tool?.inputSchema.type).toBe('object')
        expect(tool).not.toHaveProperty('outputSchema')
        expect(tool?.annotations?.readOnlyHint).toBe(true)
        const schema = OperatorToolSchemaResultSchema.parse(value(await r.client.callTool({
          name: 'operator_tool_schema_get', arguments: { name, includeOutputSchema: true },
        })))
        expect(schema.name).toBe(name)
        expect(schema.inputSchema).toEqual(tool?.inputSchema)
        expect(schema.outputSchema?.type).toBe('object')
        expect(schema.permissionRequirements.actions).toEqual(['runs:read'])
      }
      expect(discovery.map((tool) => tool.name)).not.toContain('run_start')
      const historyNames = Object.values(RUN_HISTORY_TOOLS)
      for (const detail of ['full', 'compact'] as const) {
        const response = value(await r.client.callTool({ name: 'operator_get_capabilities', arguments: { detail } }))
        const caps = detail === 'full' ? CurrentOperatorCapabilitiesSchema.parse(response)
          : OperatorCompactCapabilitiesSchema.parse(response)
        expect([...caps.tools].sort()).toEqual(discovery.map(tool => tool.name).sort())
        if (detail === 'full') {
          const full = CurrentOperatorCapabilitiesSchema.parse(response)
          for (const name of historyNames) {
            expect(full.requirements?.find(entry => entry.name === name)).toMatchObject({ name, actions: ['runs:read'] })
          }
          expect(full.runtimeLimits).toContainEqual(expect.objectContaining({ feature: 'run_board_history', state: 'limited' }))
        }
      }
      expect((await f.app.inject({ method: 'GET', url: url(RUN_HISTORY_TOOLS.snapshot, args), headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401)
      await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, args)
      const noRead = await reader(f, [{ actions: ['capabilities:read'], scope: {} }])
      const deniedDiscovery = (await noRead.client.listTools()).tools.map(tool => tool.name)
      for (const name of historyNames) expect(deniedDiscovery).not.toContain(name)
      for (const detail of ['full', 'compact'] as const) {
        const response = value(await noRead.client.callTool({ name: 'operator_get_capabilities', arguments: { detail } }))
        const caps = detail === 'full' ? CurrentOperatorCapabilitiesSchema.parse(response)
          : OperatorCompactCapabilitiesSchema.parse(response)
        for (const name of historyNames) expect(caps.tools).not.toContain(name)
        if (detail === 'full') {
          const full = CurrentOperatorCapabilitiesSchema.parse(response)
          for (const name of historyNames) expect(full.requirements?.map(entry => entry.name)).not.toContain(name)
        }
      }
      await denied(f, noRead.client, noRead.token, RUN_HISTORY_TOOLS.snapshot, args, 403, 'ACCESS_DENIED')
      await denied(f, noRead.client, noRead.token, RUN_HISTORY_TOOLS.list, scope(f), 403, 'ACCESS_DENIED')
      await denied(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, { ...args, workspaceId: 'forged-workspace' }, 403, 'ACCESS_DENIED')
      await denied(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, { ...args, workflowId: 'forged-workflow' }, 403, 'ACCESS_DENIED')
      const other = await seedAgent3(f.db.pool, f.db.directory, makeCurrentWorkflowFixture(randomUUID()))
      await denied(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, { ...args, runId: other.run.id }, 404, 'RUN_NOT_FOUND')
      await denied(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, { ...args, runId: 'nonexistent-run' }, 404, 'RUN_NOT_FOUND')
      const duplicateScope = await f.app.inject({ method: 'GET', url: url(RUN_HISTORY_TOOLS.snapshot, args) + '?runId=forged',
        headers: { authorization: `Bearer ${r.token}` } })
      expect(duplicateScope.statusCode).toBe(400)

      const old = await legacy(f, `legacy-${randomUUID()}`, '2020-01-01T00:00:00.000000Z')
      expect(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, snapshotScope(f, old.id))).toEqual({
        snapshot: { ...snapshotScope(f, old.id), kind: 'unavailable', reason: 'legacy_run' },
      })
      await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [r.principal.id, JSON.stringify([])])
      // A cached caller object must not be sufficient after live grants change.
      await expect(f.services.runs.history.snapshot(r.principal, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await expect(f.services.runs.history.list(r.principal, scope(f))).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [r.principal.id])
      await expect(f.services.runs.history.snapshot(r.principal, args)).rejects.toMatchObject({ status: 403 })
    } finally { await f.close() }
  }, 60000)

  it('reports history capabilities for permitted Run-only scopes and omits denied resources', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const args = snapshotScope(f)
      const r = await reader(f, [{ actions: ['capabilities:read'], scope: {} },
        { actions: ['runs:read'], scope: { workspaceIds: [args.workspaceId],
          workflowIds: [args.workflowId], runIds: [args.runId] } }])
      const capabilities = async (input: Record<string, unknown>) => OperatorCompactCapabilitiesSchema.parse(
        value(await r.client.callTool({ name: 'operator_get_capabilities', arguments: input })),
      )
      const historyNames = Object.values(RUN_HISTORY_TOOLS)
      expect((await capabilities({})).tools).toEqual(expect.arrayContaining(historyNames))
      expect((await capabilities(args)).tools).toEqual(expect.arrayContaining(historyNames))
      expect((await capabilities(scope(f))).tools).toContain(RUN_HISTORY_TOOLS.list)
      expect((await capabilities(scope(f))).tools).not.toContain(RUN_HISTORY_TOOLS.snapshot)
      for (const resource of [{ ...args, workspaceId: 'other-workspace' },
        { ...args, workflowId: 'other-workflow' }, { ...args, runId: 'other-run' }]) {
        const deniedCapabilities = await capabilities(resource)
        for (const name of historyNames) expect(deniedCapabilities.tools).not.toContain(name)
      }
      const persisted = await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, args)
      await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.list, scope(f))
      const noRead = await reader(f, [{ actions: ['capabilities:read'], scope: {} }])
      const deniedCapabilities = OperatorCompactCapabilitiesSchema.parse(value(await noRead.client.callTool({
        name: 'operator_get_capabilities', arguments: args,
      })))
      for (const name of historyNames) expect(deniedCapabilities.tools).not.toContain(name)
      await denied(f, noRead.client, noRead.token, RUN_HISTORY_TOOLS.snapshot, args, 403, 'ACCESS_DENIED')
      expect(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.snapshot, args)).toEqual(persisted)
    } finally { await f.close() }
  }, 60000)

  it('pages microseconds and tied IDs without duplicates despite lifecycle changes and newer admissions; filters Run-only grants', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const r = await reader(f), prefix = randomUUID(), ids = ['a', 'b', 'c', 'd'].map((letter) => `run-${prefix}-${letter}`)
      for (const [index, id] of ids.entries()) await legacy(f, id,
        `2030-01-01T00:00:00.${['123455', '123456', '123456', '123457'][index]}Z`)
      const firstInput = { ...scope(f), limit: 2 }
      const first = RunDropdownPageSchema.parse(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.list, firstInput))
      expect(first.items.map((run) => run.runId)).toEqual([ids[3], ids[2]])
      expect(first.items.every((run) => run.startedAt === null && run.status === 'queued')).toBe(true)
      expect(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.list, firstInput)).toEqual(first)
      const newId = `run-new-${randomUUID()}`
      await legacy(f, newId, '2031-01-01T00:00:00.000001Z')
      // startedAt and lifecycle are mutable; neither is the ordering key.
      await f.db.pool.query(`update runs set execution_state='running',record=record || $2::jsonb where id=$1`,
        [ids[1], JSON.stringify({ executionState: 'running', startedAt: '2032-01-01T00:00:00.000Z' })])
      const items = [...first.items], cursors = new Set<string>()
      let cursor = first.pageInfo.nextCursor
      for (let n = 0; cursor && n < 10; n++) {
        expect(cursors.has(cursor)).toBe(false); cursors.add(cursor)
        const page = RunDropdownPageSchema.parse(await parity(f, r.client, r.token, RUN_HISTORY_TOOLS.list,
          { ...scope(f), limit: 1, cursor }))
        items.push(...page.items); cursor = page.pageInfo.nextCursor
      }
      expect(cursor).toBeNull()
      expect(items.map((run) => run.runId)).toEqual([ids[3], ids[2], ids[1], ids[0], f.f.run.id])
      expect(new Set(items.map((run) => run.runId)).size).toBe(items.length)
      expect(items.some((run) => run.runId === newId)).toBe(false)
      expect(items.find((run) => run.runId === ids[1])).toMatchObject({ status: 'running', startedAt: '2032-01-01T00:00:00.000Z' })
      const only = await reader(f, [{ actions: ['runs:read'], scope: {
        workspaceIds: [scope(f).workspaceId], workflowIds: [scope(f).workflowId], runIds: [ids[0]!, ids[1]!],
      } }])
      const filtered = RunDropdownPageSchema.parse(await parity(f, only.client, only.token, RUN_HISTORY_TOOLS.list, scope(f)))
      expect(filtered.items.map((run) => run.runId)).toEqual([ids[1], ids[0]])
      await denied(f, only.client, only.token, RUN_HISTORY_TOOLS.snapshot, snapshotScope(f), 403, 'ACCESS_DENIED')
      const foreign = encodeRunHistoryCursor({ ...scope(f), workflowId: 'other' }, { admittedAt: '2030-01-01T00:00:00.000000Z', runId: ids[0]! })
      await denied(f, r.client, r.token, RUN_HISTORY_TOOLS.list, { ...scope(f), cursor: foreign }, 400, 'RUN_HISTORY_CURSOR_INVALID')
      const eligible = `eligible-${randomUUID()}`
      await legacy(f, eligible, '2034-01-01T00:00:00.000000Z', 'schedule')
      expect((await f.services.runs.history.list(r.principal, scope(f))).items.find((run) => run.runId === eligible)?.trigger).toBe('manual')
    } finally { await f.close() }
  }, 60000)

  it('enforces immutable storage and rollback, and records the internal scheduled trigger in the same common insertion', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      await expect(f.db.pool.query("update run_board_snapshots set record=jsonb_set(record,'{nodes}','[]') where run_id=$1", [f.f.run.id])).rejects.toMatchObject({ code: '23514' })
      await expect(f.db.pool.query('delete from run_board_snapshots where run_id=$1', [f.f.run.id])).rejects.toMatchObject({ code: '23514' })
      await expect(f.db.pool.query("update runs set created_at=created_at + interval '1 second' where id=$1", [f.f.run.id])).rejects.toMatchObject({ code: '23514' })
      await expect(f.db.pool.query('delete from runs where id=$1', [f.f.run.id])).rejects.toThrow()
      const failed = await acceptedAgain(f)
      await expect(withExclusiveGraphConnection(f.db.pool, (connection) => connection.transaction((sql) =>
        insertRepeatRun(sql, failed, { initializeLocked: async () => { throw new Error('publisher rollback proof') } }))))
        .rejects.toThrow(/publisher rollback proof/)
      expect((await f.db.pool.query('select id from runs where id=$1', [failed.run.id])).rowCount).toBe(0)
      expect((await f.db.pool.query('select run_id from run_board_snapshots where run_id=$1', [failed.run.id])).rowCount).toBe(0)
      // Tests the common internal seam, not a dispatcher or public scheduled Start.
      const scheduled = await acceptedAgain(f)
      await withExclusiveGraphConnection(f.db.pool, (connection) => connection.transaction((sql) =>
        insertRepeatRun(sql, scheduled, repeatStartPublication, 'schedule')))
      const page = await f.services.runs.history.list(f.writer.principal, scope(f))
      expect(page.items.find((run) => run.runId === scheduled.run.id)?.trigger).toBe('schedule')
      expect((await f.services.runs.history.snapshot(f.writer.principal, snapshotScope(f, scheduled.run.id))).snapshot.kind).toBe('available')
    } finally { await f.close() }
  }, 60000)
})
