import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentConfigurationVersionSchema, AgentSchema, type Agent } from '@foreman-code/contracts'
import * as c from '@foreman-code/contracts/management'
import * as current from '@foreman-code/contracts/wave25'
import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import { afterAll, beforeAll, expect } from 'vitest'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import { SkillCatalogService } from '../../src/modules/skills/catalog.js'
import { SkillUsageService } from '../../src/modules/skills/usage.js'
import { OperatorAgentMutationService } from '../../src/modules/workspaces/operatorAgents.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../../src/modules/workspaces/management.js'
import { CurrentWorkflowAuthoring } from '../../src/modules/workflows/currentAuthoring.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { migratedDatabase } from './migratedDatabase.js'

const configuration = {
  harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard',
} as const

export function skillConsumerFixture() {
  let database: Awaited<ReturnType<typeof migratedDatabase>>
  let app: FastifyInstance
  let address: string
  let access: PostgresAccessService
  let commands: PostgresCommandCoordinator
  let agents: OperatorAgentMutationService
  let authoring: CurrentWorkflowAuthoring
  let client: Client
  const clients: Client[] = []

  async function connect(token: string) {
    const connected = new Client({ name: 'skill-consumers', version: '1' })
    clients.push(connected)
    await connected.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return connected
  }

  async function call<T>(name: string, schema: z.ZodType<T>, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args }, { timeout: 240_000 })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    return schema.parse(decodeMcpToolResult(response))
  }

  beforeAll(async () => {
    database = await migratedDatabase()
    commands = new PostgresCommandCoordinator(database.pool)
    access = new PostgresAccessService(database.pool)
    const locations = new WorkspaceLocationService(database.pool, commands, undefined, 'runner-local')
    agents = new OperatorAgentMutationService(database.pool, commands, { qualifyConfiguration: async (value) => ({
      harness: value.harness, version: 'fixture', authenticated: true, ready: true,
      structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
      supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
    }) })
    authoring = new CurrentWorkflowAuthoring(database.pool, commands)
    const services = {
      commands, locations, workspaces: new WorkspaceManagementService(database.pool, commands, locations),
      workflows: new WorkflowManagementService(database.pool, commands),
      extensions: { agents, skills: new SkillCatalogService(database.pool, commands),
        skillUsage: new SkillUsageService(database.pool, agents, authoring, commands) },
    } as unknown as OperatorServices
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services },
    })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
    const owner = await access.issue({ name: 'Consumer owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }],
      expiresAt: new Date(Date.now() + 3_600_000) })
    client = await connect(owner.token)
  }, 60_000)

  afterAll(async () => {
    await Promise.allSettled(clients.map(connected => connected.close()))
    await app?.close()
    await database?.close()
  })

  async function makeAgent(workspaceId: string, skillId?: string, agentId = `consumer-${randomUUID()}`) {
    return (await call('agent_create', c.AgentMutationResultSchema, {
      workspaceId, agentId, commandId: randomUUID(), name: agentId, productRole: 'coder', configuration,
      assignedSkills: skillId ? [{ skillId, version: '1' }] : [],
    })).value
  }

  async function makeWorkflow(workspaceId: string, members: Agent[], name = 'Consumers') {
    const workflow = (await call('workflow_create', current.SavedManagedWorkflowCommandResultSchema, {
      workspaceId, commandId: randomUUID(), name,
    })).value
    const nodes = members.map((agent, index) => ({ id: `step-${index}`, agentId: agent.id, name: agent.name }))
    return (await call('workflow_save_v3', current.CurrentWorkflowSaveResultSchema, {
      workspaceId, workflowId: workflow.workflow.id, executionSemanticsVersion: 3, commandId: randomUUID(),
      expectedRevision: workflow.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: Object.fromEntries(members.map(agent => [agent.id, agent.configurationVersionId])),
      graph: { ...workflow.workflow, entryNodeId: nodes[0]!.id, nodes,
        edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, kind: 'execution',
          source: nodes[index]!.id, target: node.id })),
        approval: { handler: 'user' }, executionCondition: { kind: 'manual' },
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: members.length },
      },
    })).value
  }

  async function fixture() {
    const workspace = (await call('workspace_create', c.ManagedWorkspaceCommandResultSchema, {
      commandId: randomUUID(), name: 'Skill consumers',
    })).value
    const workspaceId = workspace.workspace.id
    const rootPath = join(database.directory, randomUUID())
    await mkdir(rootPath)
    await call('workspace_location_set', c.WorkspaceLocationSetResultSchema, {
      workspaceId, commandId: randomUUID(), expectedLocationRevision: workspace.locationRevision,
      runnerId: 'runner-local', rootPath,
    })
    const skill = (await call('skill_create', c.SkillMutationResultSchema, {
      workspaceId, commandId: randomUUID(), name: 'Guide', instructions: 'Version one',
    })).value.skill
    const consumer = await makeAgent(workspaceId, skill.skillId)
    const workflow = await makeWorkflow(workspaceId, [consumer.agent])
    return { workspaceId, skillId: skill.skillId, skill, consumer, workflow }
  }

  async function publish(workspaceId: string, skillId: string, revision: number, instructions: string) {
    return call('skill_update', c.SkillMutationResultSchema, {
      workspaceId, skillId, commandId: randomUUID(), expectedRevision: revision, name: 'Guide', instructions,
    })
  }

  async function seedConsumerFixtures(f: Awaited<ReturnType<typeof fixture>>) {
    const baseConfiguration = await configurationOf(f.workspaceId, f.consumer.agent.id)
    const records = JSON.stringify(Array.from({ length: 1000 }, (_, index) => {
      const agentId = `consumer-${f.workspaceId}-${index}`
      const configuration = AgentConfigurationVersionSchema.parse({
        ...baseConfiguration, id: randomUUID(), agentId,
      })
      const agent = AgentSchema.parse({ ...f.consumer.agent, id: agentId, name: `Consumer ${index}`,
        configurationVersionId: configuration.id })
      const workflowId = randomUUID()
      const version = current.WorkflowVersionV3Schema.parse({ ...f.workflow.version, id: randomUUID(), workflowId,
        agentConfigurationVersionIds: { [agentId]: configuration.id },
        definition: { ...f.workflow.version.definition, id: workflowId,
          nodes: [{ ...f.workflow.version.definition.nodes[0]!, agentId, name: agent.name }] } })
      version.contentHash = graphSourceDigest({ definition: version.definition,
        configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })
      return { agent, configuration, version, graph: version.definition }
    }))
    await withTransaction(database.pool, async sql => {
      await sql.query(`insert into agents(id,workspace_id,record)
        select item#>>'{agent,id}',$2,item->'agent' from jsonb_array_elements($1::jsonb) item`, [records, f.workspaceId])
      await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
        select item#>>'{configuration,id}',$2,item#>>'{agent,id}',
          (item#>>'{configuration,version}')::integer,item->'configuration'
        from jsonb_array_elements($1::jsonb) item`, [records, f.workspaceId])
      await sql.query(`update agents set current_configuration_version_id=item#>>'{configuration,id}'
        from jsonb_array_elements($1::jsonb) item where agents.id=item#>>'{agent,id}'`, [records])
      await sql.query(`insert into workflows(id,workspace_id,current_version_id,record,revision)
        select item#>>'{graph,id}',$2,item#>>'{version,id}',item->'graph',$3
        from jsonb_array_elements($1::jsonb) item`, [records, f.workspaceId, f.workflow.revision])
      await sql.query(`insert into workflow_versions
        (id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
        select item#>>'{version,id}',$2,item#>>'{graph,id}',(item#>>'{version,version}')::integer,
          item#>>'{version,entryNodeId}',item->'version',3 from jsonb_array_elements($1::jsonb) item`,
      [records, f.workspaceId])
    })
  }

  async function configurationOf(workspaceId: string, agentId: string) {
    const rows = await database.pool.query<{ record: unknown }>(
      `select c.record from agents a join agent_configuration_versions c on c.id=a.current_configuration_version_id
       where a.workspace_id=$1 and a.id=$2`, [workspaceId, agentId])
    return AgentConfigurationVersionSchema.parse(rows.rows[0]?.record)
  }

  return {
    call, connect, makeAgent, makeWorkflow, fixture, publish, seedConsumerFixtures, configurationOf,
    get database() { return database },
    get access() { return access },
    get commands() { return commands },
    get authoring() { return authoring },
    get client() { return client },
  }
}
