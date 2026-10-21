import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { z } from 'zod'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as c from '@foreman-code/contracts/management'
import * as current from '@foreman-code/contracts/wave25'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { CurrentWorkflowAuthoring } from '../src/modules/workflows/currentAuthoring.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { SkillCatalogService } from '../src/modules/skills/catalog.js'
import { SkillUsageService } from '../src/modules/skills/usage.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it.skipIf(!process.env.TEST_DATABASE_URL)('moves Agents and their saved workflows to a skill\'s current version in one step', async () => {
  const connectionString = process.env.TEST_DATABASE_URL!
  const parsed = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.includes('test')) throw new Error('Use a disposable loopback test database')
  const schema = 'skill_users_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString })
  const parentPath = await mkdtemp(join(tmpdir(), 'skill-users-'))
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const clients: Client[] = []
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands, undefined, 'runner-local')
  const agents = new OperatorAgentMutationService(pool, commands, { qualifyConfiguration: async (configuration) => ({
    harness: configuration.harness, version: 'synthetic-test-port', authenticated: true, ready: true,
    structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
    supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
  }) })
  const services = {
    commands, locations, workspaces: new WorkspaceManagementService(pool, commands, locations),
    workflows: new WorkflowManagementService(pool, commands),
    extensions: { agents, skills: new SkillCatalogService(pool, commands),
      skillUsage: new SkillUsageService(pool, agents, new CurrentWorkflowAuthoring(pool, commands), commands) },
  } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services } })
  try {
    await applyApplicationMigrations(pool)
    const owner = await access.issue({ name: 'Skill owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'skill-users-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token)
    const call = async <T>(name: string, schemaValue: z.ZodType<T>, args: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name, arguments: args })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      return schemaValue.parse(decodeMcpToolResult(response))
    }
    const workspace = (await call('workspace_create', c.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Skills' })).value
    const workspaceId = workspace.workspace.id
    const repository = { provider: 'github', owner: 'octo-owner', name: 'website', defaultBranch: 'main' }
    const withRepository = (await call('workspace_update', c.ManagedWorkspaceCommandResultSchema, { workspaceId,
      commandId: randomUUID(), expectedRevision: workspace.revision, repository })).value
    expect((await call('workspace_get', c.ManagedWorkspaceSchema, { workspaceId })).workspace.repository).toEqual(repository)
    expect((await client.callTool({ name: 'workspace_update', arguments: { workspaceId, commandId: randomUUID(),
      expectedRevision: withRepository.revision, repository: { ...repository, owner: '../evil' } } })).isError).toBe(true)
    const project = join(parentPath, 'project'); await mkdir(project)
    await call('workspace_location_set', c.WorkspaceLocationSetResultSchema, { workspaceId, commandId: randomUUID(),
      expectedLocationRevision: withRepository.locationRevision, runnerId: 'runner-local', rootPath: project })
    const skill = (await call('skill_create', c.SkillMutationResultSchema, { workspaceId, commandId: randomUUID(),
      name: 'Reviewer', instructions: 'Version one' })).value
    const skillId = skill.skill.skillId
    const configuration = { harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' }
    const agent = (await call('agent_create', c.AgentMutationResultSchema, { workspaceId, commandId: randomUUID(), agentId: 'reviewer',
      name: 'Reviewer', productRole: 'coder', configuration, assignedSkills: [{ skillId, version: skill.version.version }] })).value.agent
    const workflow = (await call('workflow_create', current.SavedManagedWorkflowCommandResultSchema,
      { workspaceId, commandId: randomUUID(), name: 'Review' })).value
    const saved = await call('workflow_save_v3', current.CurrentWorkflowSaveResultSchema, { workspaceId, workflowId: workflow.workflow.id,
      executionSemanticsVersion: 3, commandId: randomUUID(), expectedRevision: workflow.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: { [agent.id]: agent.configurationVersionId },
      graph: { ...workflow.workflow, entryNodeId: 'review', nodes: [{ id: 'review', agentId: agent.id, name: 'Reviewer' }], edges: [],
        approval: { handler: 'user' }, executionCondition: { kind: 'manual', description: 'Manual' },
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 5 } } })

    await call('skill_update', c.SkillMutationResultSchema, { workspaceId, skillId, commandId: randomUUID(),
      expectedRevision: skill.skill.revision, name: 'Reviewer', instructions: 'Version two' })
    const usage = await call('skill_usage_get', c.SkillUsageSchema, { workspaceId, skillId })
    expect(usage).toEqual({ skillId, headVersion: '2', agents: [{ agentId: 'reviewer', name: 'Reviewer', version: '1' }],
      workflows: [{ workflowId: workflow.workflow.id, name: 'Review' }] })

    const reader = await connect((await access.issue({ name: 'Skill reader', audience: 'operator',
      grants: [{ actions: ['skills:read', 'workflows:read', 'graph:read'], scope: { workspaceIds: [workspaceId] } }],
      expiresAt: new Date(Date.now() + 120_000) })).token)
    expect((await reader.callTool({ name: 'workspace_update', arguments: { workspaceId, commandId: randomUUID(),
      expectedRevision: 1, repository: null } })).isError).toBe(true)
    expect((await call('workspace_get', c.ManagedWorkspaceSchema, { workspaceId })).workspace.repository).toEqual(repository)
    const denied = await reader.callTool({ name: 'skill_users_update', arguments: { workspaceId, skillId, commandId: randomUUID() } })
    expect(denied.isError).toBe(true)
    expect((await pool.query('select count(*)::int as count from agent_configuration_versions where agent_id=$1', ['reviewer'])).rows[0].count).toBe(1)

    const commandId = 'c'.repeat(200)
    const updated = await call('skill_users_update', c.SkillUsersUpdateResultSchema, { workspaceId, skillId, commandId })
    expect(updated.failed).toEqual([])
    expect(updated.agents.map(value => value.agentId)).toEqual(['reviewer'])
    expect(updated.workflows.map(value => value.workflowId)).toEqual([workflow.workflow.id])
    const configurationRow = (await pool.query<{ record: unknown }>(`select c.record from agents a join agent_configuration_versions c
      on c.id=a.current_configuration_version_id where a.id=$1`, ['reviewer'])).rows[0]!
    const latest = AgentConfigurationVersionSchema.parse(configurationRow.record)
    expect(latest.assignedSkills).toEqual([{ skillId, version: '2' }])
    expect(latest.resolvedSkills?.[0]?.instructions).toBe('Version two')
    const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, { workspaceId, workflowId: workflow.workflow.id })
    expect(read.version.id).not.toBe(saved.value.currentVersionId)
    expect(read.version.agentConfigurationVersionIds).toEqual({ reviewer: latest.id })
    expect(await call('skill_usage_get', c.SkillUsageSchema, { workspaceId, skillId })).toMatchObject({ agents: [], workflows: [] })
    const http = await fetch(new URL(`/api/management/workspaces/${workspaceId}/skills/${skillId}/update-users`, address), {
      method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ commandId }) })
    expect(c.SkillUsersUpdateResultSchema.parse(await http.json())).toEqual(updated)
    expect((await pool.query('select count(*)::int as count from agent_configuration_versions where agent_id=$1',
      ['reviewer'])).rows[0].count).toBe(2)
    await call('skill_update', c.SkillMutationResultSchema, { workspaceId, skillId, commandId: randomUUID(),
      expectedRevision: 2, name: 'Reviewer', instructions: 'Version three' })
    const httpCommand = randomUUID()
    const httpUpdate = await fetch(new URL(`/api/management/workspaces/${workspaceId}/skills/${skillId}/update-users`, address), {
      method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: httpCommand }) })
    expect(c.SkillUsersUpdateResultSchema.parse(await httpUpdate.json()).failed).toEqual([])
    const audits = (await pool.query<{ source: string; principal_id: string; action: string; target_key: string }>(
      "select source,principal_id,action,target_key from management_audit where action='agent.update' order by sequence")).rows
    expect(audits).toEqual([
      { source: 'mcp', principal_id: owner.principal.id, action: 'agent.update', target_key: `workspace:${workspaceId}:agent:reviewer` },
      { source: 'http', principal_id: owner.principal.id, action: 'agent.update', target_key: `workspace:${workspaceId}:agent:reviewer` },
    ])

  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close(); await pool.end(); await dropFixtureSchema(admin, schema); await admin.end(); await removeFixtureDirectory(parentPath)
  }
}, 120_000)
