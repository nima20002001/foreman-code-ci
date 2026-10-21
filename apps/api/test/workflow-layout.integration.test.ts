import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AgentSchema } from '@foreman-code/contracts'
import { ManagementActionSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  SavedManagedWorkflowCommandResultSchema, SavedManagedWorkflowSchema, makeCurrentWorkflowFixture,
  type CurrentFixtureForm,
} from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { currentDatabase as agent3Database, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphRpc, graphRpcValue, graphHeaders } from './eng04-graph-composition-fixture.js'
import { insertCurrentRunFixture as insertFixtureRepeatRun } from './helpers/eng04CurrentRunFixture.js'

/** Real migrated PostgreSQL, issued bearer auth, typed writer, command/audit and
 * stateless Operator MCP. No native engine is composed; the active Run is an
 * explicit canonical SQL fixture, not native admission or closure proof. */
describe.skipIf(!postgresEnabled)('current layout HTTP/MCP', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const apps: ReturnType<typeof buildApp>[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture(form: CurrentFixtureForm = 'sequential') {
    const f = makeCurrentWorkflowFixture(randomUUID(), form)
    const configurations = f.configurations
    // Only workspace/Agent configuration fixtures are seeded. No workflow or
    // immutable v3 version is inserted here; both travel through product HTTP/MCP.
    await db.pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
      values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [f.scope.workspaceId,
    JSON.stringify({ id: f.scope.workspaceId, name: 'Current workflow fixture' }),
    JSON.stringify({ runnerId: 'runner-local', rootPath: db.directory }), JSON.stringify({ fixture: true })])
    for (const config of configurations) {
      const agent = AgentSchema.parse({ id: config.agentId, name: 'Fixture Worker', productRole: config.productRole,
        harness: config.harness.harness, model: config.harness.model, effort: 'low', fastMode: false,
        harnessConfiguration: config.harness, prompt: config.prompt, assignedSkills: config.assignedSkills, configurationVersionId: config.id })
      await db.pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)', [agent.id, f.scope.workspaceId, JSON.stringify(agent)])
      await db.pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)',
        [config.id, f.scope.workspaceId, config.agentId, JSON.stringify(config)])
      await db.pool.query('update agents set current_configuration_version_id=$2 where id=$1', [agent.id, config.id])
    }
    const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
    const credential = (grants: ManagementGrant[]) => access.issue({ name: 'Current workflow test caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants })
    const writer = await credential([{ actions: ['capabilities:read'], scope: {} }, {
      actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'), scope: { workspaceIds: [f.scope.workspaceId] },
    }])
    const workflows = new WorkflowManagementService(db.pool, commands)
    const services = { workflows, commands } as OperatorServices
    const app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } }, checkpoints: { ping: async () => undefined } },
      operator: { access, services } })
    apps.push(app); await app.ready()
    const createInput = { workspaceId: f.scope.workspaceId, commandId: randomUUID(), name: `Current ${form}` }
    const created = await app.inject({ method: 'POST', url: `/api/management/workspaces/${f.scope.workspaceId}/workflows`,
      headers: graphHeaders(writer.token), payload: createInput })
    expect(created.statusCode, created.body).toBe(201)
    const managed = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
    expect(managed.workflow.executionSemanticsVersion).toBe(3)
    expect(Object.hasOwn(managed.workflow, 'repeat')).toBe(false)
    const createReplay = await graphRpc(app, writer.token, 'tools/call', { name: 'workflow_create', arguments: createInput })
    expect(createReplay.result?.isError).not.toBe(true)
    expect(graphRpcValue(createReplay.result)).toMatchObject({ value: managed, replayed: true })
    const graph = { ...f.version.definition, id: managed.workflow.id,
      version: managed.workflow.version, createdAt: managed.workflow.createdAt, updatedAt: managed.workflow.updatedAt,
      name: managed.workflow.name }
    const input = CurrentWorkflowSaveInputSchema.parse({ workspaceId: f.scope.workspaceId, workflowId: managed.workflow.id,
      commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: managed.revision,
      expectedWorkflowVersionId: null, expectedAgentConfigurationVersionIds: Object.fromEntries(configurations.map((config) => [config.agentId, config.id])),
      graph })
    const url = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/definition`
    const call = async (name: string, args: unknown, token = writer.token) => graphRpc(app, token, 'tools/call', { name, arguments: args })
    return { app, input, url, writer, access, credential, commands, workflows, call, f, configurations }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const httpSave = (t: Fixture, input = t.input, token = t.writer.token) => t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(token), payload: input })
  async function save(t: Fixture) {
    const result = await httpSave(t); expect(result.statusCode, result.body).toBe(200)
    return CurrentWorkflowSaveResultSchema.parse(result.json())
  }
  async function count(t: Fixture, table: 'workflow_versions' | 'runs') {
    return Number((await db.pool.query<{ n: string }>(`select count(*)::text as n from ${table} where workflow_id=$1`, [t.input.workflowId])).rows[0]!.n)
  }
  it('accepts later layout writes while a Run remains active and preserves versions, replay and denied writes', async () => {
    const t = await fixture(), first = await save(t)
    await insertFixtureRepeatRun(db.pool, { ...t.f, configurations: t.configurations, run: { ...t.f.run,
      workflowId: t.input.workflowId, createdAt: new Date().toISOString(), agentConfigurationVersionIds: first.value.version.agentConfigurationVersionIds,
      approval: first.value.version.approval,
      executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` },
    } }, first.value, t.writer.principal.id, { input: {} })
    const original = first.value.version.definition
    const layout = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId,
      graph: { ...original, nodes: original.nodes.map((node, index) => index ? node : {
        ...node, position: { x: 901, y: 42 }, width: 360, height: 280,
      }) } }
    const moved = await t.call(CURRENT_WORKFLOW_TOOLS.save, layout)
    expect(moved.result?.isError, JSON.stringify(moved.result)).not.toBe(true)
    const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(moved.result))
    expect(saved.value.revision).toBe(first.value.revision)
    expect(saved.value.currentVersionId).toBe(first.value.currentVersionId)
    const stale = { ...layout, commandId: randomUUID(), graph: { ...original,
      nodes: original.nodes.map((node, index) => index === 1 ? { ...node, position: { x: 1200, y: 99 } } : node) } }
    const later = await httpSave(t, stale)
    expect(later.statusCode, later.body).toBe(200)
    expect(CurrentWorkflowSaveResultSchema.parse(later.json()).value.version).toEqual(first.value.version)
    // Replaying an earlier command returns its result without applying it again.
    const replay = await t.call(CURRENT_WORKFLOW_TOOLS.save, layout)
    expect(graphRpcValue(replay.result)).toEqual({ ...saved, replayed: true })
    const read = await t.call('workflow_get', { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })
    const readback = SavedManagedWorkflowSchema.parse(graphRpcValue(read.result))
    expect(readback).toMatchObject({ revision: first.value.revision,
      currentVersionId: first.value.currentVersionId, workflow: { nodes: stale.graph.nodes } })
    expect(readback.workflow.nodes).toEqual([
      original.nodes[0],
      { ...original.nodes[1], position: { x: 1200, y: 99 } },
    ])
    for (const field of ['position', 'width', 'height']) {
      expect(Object.hasOwn(readback.workflow.nodes[0]!, field)).toBe(false)
    }
    const denied = await t.credential([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [t.input.workspaceId] } }])
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.save, layout, denied.token)).result?.isError).toBe(true)
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(await count(t, 'runs')).toBe(1)
    expect((await db.pool.query(`select execution_state from runs where workflow_id=$1`, [t.input.workflowId])).rows[0]?.execution_state).not.toBe('completed')
  })
  it('marks only Operator-edited positions as manual and reads them back through authenticated MCP', async () => {
    const t = await fixture()
    const capabilities = await t.call(CURRENT_WORKFLOW_TOOLS.capabilities, {})
    expect(graphRpcValue(capabilities.result)).toMatchObject({
      nodeGeometry: { manualPositionField: 'node.position.manual', automaticLayout: 'hierarchy', operatorPositionsManual: true },
    })
    t.input.graph.nodes = t.input.graph.nodes.map((node, index) => ({
      ...node, position: { x: 320, y: index * 300 },
    }))
    const first = await save(t)
    const original = first.value.version.definition
    const layout = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId,
      graph: { ...original, nodes: original.nodes.map((node, index) => index ? node : {
        ...node, position: { x: 901, y: 42 },
      }) } }
    const readInput = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId }
    const denied = await t.credential([{ actions: ['workflows:read', 'graph:read'],
      scope: { workspaceIds: [t.input.workspaceId] } }])
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.save, layout, denied.token)).result?.isError).toBe(true)
    const read = async () => SavedManagedWorkflowSchema.parse(
      graphRpcValue((await t.call('workflow_get', readInput)).result))
    expect((await read()).workflow.nodes).toEqual(original.nodes)
    const moved = await t.call(CURRENT_WORKFLOW_TOOLS.save, layout)
    expect(moved.result?.isError, JSON.stringify(moved.result)).not.toBe(true)
    const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(moved.result))
    expect(saved.value.version).toEqual(first.value.version)
    expect(saved.value.revision).toBe(first.value.revision)
    const readback = await read()
    expect(readback.workflow.nodes).toEqual([
      { ...original.nodes[0], position: { x: 901, y: 42, manual: true } }, original.nodes[1],
    ])
    expect(readback.currentVersionId).toBe(first.value.currentVersionId)
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.save, layout)).result?.isError).not.toBe(true)
    expect((await read()).workflow.nodes).toEqual(readback.workflow.nodes)
    expect(await count(t, 'workflow_versions')).toBe(1)
  })
})
