import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AgentSchema, AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import * as c from '@foreman-code/contracts/management'
import { canonicalGraphJson, makeCurrentWorkflowFixture, WorkflowRunV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('batch archives workspaces through authenticated MCP with atomic conflicts, active-run protection, scoped denial and replay', async () => {
  const connectionString = process.env.TEST_DATABASE_URL!
  const schema = 'batch_page_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands)
  const workspaces = new WorkspaceManagementService(pool, commands, locations)
  const workflows = new WorkflowManagementService(pool, commands)
  const services = { commands, workspaces, workflows } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  const clients: Client[] = []
  try {
    await applyApplicationMigrations(pool)
    const owner = await access.issue({ name: 'Batch owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'batch-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('workspace_batch_archive')
    const first = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'First' })).value
    const second = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Second' })).value
    const input = { commandId: randomUUID(), workspaces: [first, second].map((item) => ({ workspaceId: item.workspace.id, expectedRevision: item.revision })) }
    const reader = await access.issue({ name: 'Reader', audience: 'operator', grants: [{ actions: ['workspaces:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const denied = await connect(reader.token)
    expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('workspace_batch_archive')
    await expectMcpAccessDenied(denied.callTool({ name: 'workspace_batch_archive', arguments: input }))
    const scoped = await access.issue({ name: 'Scoped', audience: 'operator', grants: [{ actions: ['workspaces:archive'], scope: { workspaceIds: [first.workspace.id] } }], expiresAt: new Date(Date.now() + 60_000) })
    expect((await (await connect(scoped.token)).callTool({ name: 'workspace_batch_archive', arguments: input })).isError).toBe(true)
    const rejected = await client.callTool({ name: 'workspace_batch_archive', arguments: { ...input, commandId: randomUUID(),
      workspaces: [input.workspaces[0], { ...input.workspaces[1], expectedRevision: 99 }],
    } })
    expect(rejected.isError).toBe(true)
    expect((await pool.query('select count(*) from workspaces where archived_at is not null')).rows[0].count).toBe('0')
    const workflow = (await workflows.create(owner.principal, 'http', { workspaceId: first.workspace.id, name: 'Retained workflow', commandId: randomUUID() })).value.workflow
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
    const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonicalGraphJson(value)).digest('hex')}`
    for (const original of fixture.configurations) {
      const value = { ...original, workspaceId: first.workspace.id }
      const configuration = AgentConfigurationVersionSchema.parse({ ...value, contentHash: hash(Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'contentHash'))) })
      const agent = AgentSchema.parse({ id: configuration.agentId, name: 'Archive fixture Worker',
        productRole: configuration.productRole, harness: configuration.harness.harness,
        model: configuration.harness.model, effort: 'low', fastMode: false,
        harnessConfiguration: configuration.harness, prompt: configuration.prompt,
        assignedSkills: configuration.assignedSkills, configurationVersionId: configuration.id })
      await pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
        [agent.id, first.workspace.id, JSON.stringify(agent)])
      await pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
        values($1,$2,$3,1,$4::jsonb)`, [configuration.id, first.workspace.id, agent.id, JSON.stringify(configuration)])
    }
    const definition = { ...fixture.version.definition, id: workflow.id, workspaceId: first.workspace.id }
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, id: 'version-active',
      workspaceId: first.workspace.id, workflowId: workflow.id,
      definition, contentHash: hash({ definition, configurations: fixture.version.agentConfigurationVersionIds,
        entryNodeId: fixture.version.entryNodeId }) })
    const run = WorkflowRunV3Schema.parse({ ...fixture.run, id: 'run-active', workspaceId: first.workspace.id,
      workflowId: workflow.id, workflowVersionId: version.id, agentConfigurationVersionIds: version.agentConfigurationVersionIds,
      executionState: 'running' })
    await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
      values ($1,$2,$3,$4,$5,$6::jsonb,3)`, [version.id, version.workspaceId, version.workflowId,
      version.version, version.entryNodeId, JSON.stringify(version)])
    await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values ($1,$2,$3,$4,$5,$6::jsonb)`, [run.id, run.workspaceId, run.workflowId, run.workflowVersionId,
      run.executionState, JSON.stringify(run)])
    const active = await client.callTool({ name: 'workspace_batch_archive', arguments: input })
    expect(active.isError).toBe(true)
    expect(JSON.stringify(active)).toContain('ARCHIVE_BLOCKED_BY_ACTIVE_RUN')
    expect((await pool.query('select count(*) from workspaces where archived_at is not null')).rows[0].count).toBe('0')
    const completed = WorkflowRunV3Schema.parse({ ...run, executionState: 'completed', outcome: 'canceled',
      result: { outcome: 'canceled' }, finishedAt: new Date().toISOString() })
    await pool.query("update runs set execution_state='completed',record=$2::jsonb where id=$1", [run.id, JSON.stringify(completed)])
    const result = c.WorkspaceBatchArchiveResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workspace_batch_archive', arguments: input }))))
    expect(result.replayed).toBe(false)
    expect(result.value.workspaceIds.sort()).toEqual([first.workspace.id, second.workspace.id].sort())
    const replay = c.WorkspaceBatchArchiveResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workspace_batch_archive', arguments: input }))))
    expect(replay.replayed).toBe(true)
    const listing = c.ManagedWorkspacePageSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workspace_list', arguments: { detail: 'full' } }))))
    expect(listing.items).toEqual([])
    const readback = c.ManagedWorkspaceSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workspace_get', arguments: { workspaceId: first.workspace.id } }))))
    expect(readback.archivedAt).not.toBeNull(); expect(readback.revision).toBe(first.revision + 1)
    expect((await pool.query('select count(*) from workflows')).rows[0].count).toBe('1')
    expect((await pool.query('select count(*) from runs')).rows[0].count).toBe('1')
    expect((await pool.query("select count(*) from management_audit where action='workspace.batch_archive' and outcome='succeeded'")).rows[0].count).toBe('1')
  } finally {
    for (const client of clients) await client.close()
    await app.close(); await pool.end()
    await dropFixtureSchema(admin, schema); await admin.end()
  }
}, 30_000)
