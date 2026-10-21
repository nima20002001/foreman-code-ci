import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { AgentSchema } from '@foreman-code/contracts'
import { ManagementActionSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import {
  CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { graphRpc, graphRpcValue, graphHeaders } from './eng04-graph-composition-fixture.js'

// Each test owns a migrated schema and uses a failing engine to detect unauthorized native calls.
export function useWorkflowManagementFixture() {
  let db: Awaited<ReturnType<typeof currentDatabase>>
  const apps: ReturnType<typeof buildApp>[] = []
  beforeEach(async () => { db = await currentDatabase() }, 60000)
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
    await db?.close()
  })
  async function fixture(form: 'single' | 'sequential' = 'sequential') {
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
    const locations = new WorkspaceLocationService(db.pool, commands, db.directory, 'runner-local')
    const workflowRepository = new PostgresWorkflowRepository(db.pool)
    const repository = new PostgresRunRepository(db.pool, workflowRepository, locations, { runtimeRoot: db.directory,
      ...createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify) })
    const start = vi.fn(async () => { throw new Error('UNQUALIFIED_NATIVE_START_REACHED') })
    const cancel = vi.fn(async () => { throw new Error('UNQUALIFIED_NATIVE_STOP_REACHED') })
    const runs = new RunManagementService(db.pool, commands, repository, { start, cancel } as unknown as LangGraphWorkflowEngine, locations)
    const services = { workflows, commands, runs,
      runGraph: new RunGraphReadService(db.pool, { qualifiedReads: true }) } as unknown as OperatorServices
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
    return { app, input, url, writer, access, credential, commands, workflows, call, f, configurations, start, cancel }
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
  async function agentStage(t: Fixture, first: Awaited<ReturnType<typeof save>>) {
    const original = (await db.pool.query('select record,metadata_revision::text from agents where id=$1', [t.configurations[0]!.agentId])).rows[0]!
    const agent = AgentSchema.parse(original.record)
    return { ...t.input, action: 'stage_edits' as const, draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      expectedRevision: first.value.revision, expectedWorkflowVersionId: first.value.currentVersionId,
      graph: first.value.version.definition, stagedAgents: [{ agent: { ...agent, name: 'Private new name',
        prompt: { ...agent.prompt, system: 'Use the staged instructions.' } }, baseRevision: Number(original.metadata_revision) }] }
  }
  return {
    get db() {
      return db
    },
    fixture,
    httpSave,
    save,
    count,
    agentStage,
  }
}
