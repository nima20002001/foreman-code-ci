import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { callWorkspaceTool } from './helpers/workspaceMcp.js'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { mkdtemp, mkdir, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { z } from 'zod'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as c from '@foreman-code/contracts/management'
import * as current from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { HarnessDirectoryBrowser } from '../src/modules/harnesses/directoryBrowser.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it.skipIf(!process.env.TEST_DATABASE_URL)('provides authenticated Operator MCP parity for creation, defaults and workspace/workflow settings', async () => {
  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required')
  const parsed = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.includes('test')) throw new Error('Use a disposable loopback test database')
  const schema = 'mcp_parity_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString })
  const directory = await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT!, 'mcp-parity-'))
  const parentPath = join(directory, 'workspaces')
  const outsideParent = join(directory, 'outside')
  await mkdir(parentPath)
  await mkdir(outsideParent)
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const clients: Client[] = []
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands, undefined, 'runner-local')
  const settings = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(pool, parentPath), commands)
  const services = {
    harnessSettings: { directories: new HarnessDirectoryBrowser([parentPath], pool), mcp: {} },
    commands, locations, settings, workspaces: new WorkspaceManagementService(pool, commands, locations),
    workflows: new WorkflowManagementService(pool, commands),
    extensions: { agents: new OperatorAgentMutationService(pool, commands, { qualifyConfiguration: async (configuration) => ({
      harness: configuration.harness, version: 'synthetic-test-port', authenticated: true, ready: true,
      structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
      supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
    }) }) },
  } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  try {
    await applyApplicationMigrations(pool)
    const owner = await access.issue({ name: 'Parity owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    // Match the native Operator's delegated credential, not just an owner browser token.
    const delegated = await access.issue({ name: 'Parity Operator', audience: 'operator',
      grants: owner.principal.grants, expiresAt: new Date(Date.now() + 120_000) })
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [delegated.principal.id, owner.principal.id])
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'parity-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(delegated.token)
    async function call<T>(name: string, schema: z.ZodType<T>, args: Record<string, unknown> = {}) {
      const response = await client.callTool({ name, arguments: args })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      return schema.parse(decodeMcpToolResult(response))
    }
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name)
    expect(toolNames).toEqual(expect.arrayContaining(['workspace_create', 'workspace_update', 'workspace_defaults_update', 'workspace_location_set', 'workflow_create', 'workflow_update', 'workflow_defaults_update', 'workflow_validate_v3', 'workflow_save_v3', 'workspace_folder_undo']))
    const defaults = await call('workspace_defaults_get', c.ManagedWorkspaceDefaultsSchema)
    await call('workspace_defaults_update', c.WorkspaceDefaultsUpdateResultSchema, {
      commandId: randomUUID(), expectedRevision: defaults.revision, value: { ...defaults.value, parentPath },
    })
    const savedDefaults = await call('workspace_defaults_get', c.ManagedWorkspaceDefaultsSchema)
    expect(savedDefaults.value.parentPath).toBe(parentPath)
    const create = { commandId: randomUUID(), name: 'MCP Project', parentPath: savedDefaults.value.parentPath }
    const workspace = (await call('workspace_create', c.ManagedWorkspaceCommandResultSchema, create)).value
    const workspaceId = workspace.workspace.id
    expect(workspace.executionLocation?.rootPath).toBe(join(parentPath, 'MCP Project'))
    expect(workspace.locationValidation.status).toBe('ready')
    const selectedParent = dirname(parentPath)
    const outside = await call('workspace_location_validate', c.WorkspaceLocationValidationSchema, {
      workspaceId, runnerId: 'runner-local', rootPath: selectedParent,
    })
    expect(outside.location.rootPath).toBe(selectedParent)
    const outsideDefault = await call('workspace_defaults_update', c.WorkspaceDefaultsUpdateResultSchema, {
      commandId: randomUUID(), expectedRevision: savedDefaults.revision,
      value: { ...savedDefaults.value, parentPath: selectedParent },
    })
    expect((await call('workspace_defaults_get', c.ManagedWorkspaceDefaultsSchema)).value.parentPath).toBe(selectedParent)
    const restoredDefault = await call('workspace_defaults_update', c.WorkspaceDefaultsUpdateResultSchema, {
      commandId: randomUUID(), expectedRevision: outsideDefault.value.revision, value: savedDefaults.value,
    })
    savedDefaults.revision = restoredDefault.value.revision

    const overview = await call('workspace_list', c.ManagedWorkspacePageSchema, { detail: 'full' })
    expect(overview.items.find((item) => item.workspace.id === workspaceId)?.executionLocation).toEqual(workspace.executionLocation)
    const reader = await access.issue({ name: 'Metadata only', audience: 'operator',
      grants: [{ actions: ['workspaces:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const readerClient = await connect(reader.token)
    const restrictedList = await callWorkspaceTool(readerClient, 'workspace_list', c.ManagedWorkspacePageSchema,
      { detail: 'full' })
    expect(restrictedList.items[0]?.locationValidation.status).toBe('restricted')
    expect(restrictedList.items[0]?.executionLocation).toBeNull()
    expect((await call('workspace_create', c.ManagedWorkspaceCommandResultSchema, create)).replayed).toBe(true)
    expect(await readdir(parentPath)).toEqual(['MCP Project'])
    const listed = await call('workspace_folders_list', c.HarnessDirectoryBrowseResultSchema)
    expect(listed.path).toBe(parentPath)
    const folderInput = { parentPath, name: 'Picker folder', commandId: randomUUID() }
    const folder = await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, folderInput)
    expect(folder.value.path).toBe(join(parentPath, 'Picker folder'))
    expect((await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, folderInput)).replayed).toBe(true)
    expect((await client.callTool({ name: 'workspace_folder_create', arguments: { ...folderInput, commandId: randomUUID() } })).isError).toBe(true)
    const outsideFolder = await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, {
      ...folderInput, parentPath: outsideParent, commandId: randomUUID(),
    })
    expect(outsideFolder.value.path).toBe(join(outsideParent, folderInput.name))
    expect(await readdir(outsideParent)).toEqual([folderInput.name])
    expect((await client.callTool({ name: 'workspace_folder_create', arguments: { ...folderInput, name: '../escape', commandId: randomUUID() } })).isError).toBe(true)
    expect((await call('workspace_folders_list', c.HarnessDirectoryBrowseResultSchema)).directories.map((entry) => entry.name)).toContain('Picker folder')
    const automaticInput = { parentPath, commandId: randomUUID() }
    const automatic = await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, automaticInput)
    expect(automatic.value.name).toBe('New folder')
    const secondInput = { parentPath, commandId: randomUUID() }
    const second = await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, secondInput)
    expect(second.value.name).toBe('New folder (2)')
    const renameInput = { creationCommandId: automaticInput.commandId, name: 'Named folder', commandId: randomUUID() }
    const renamed = await call('workspace_folder_rename', c.WorkspaceFolderRenameResultSchema, renameInput)
    expect(renamed.value.path).toBe(join(parentPath, 'Named folder'))
    expect((await call('workspace_folder_rename', c.WorkspaceFolderRenameResultSchema, renameInput)).replayed).toBe(true)
    const collision = await client.callTool({ name: 'workspace_folder_rename', arguments: {
      creationCommandId: folderInput.commandId, name: 'MCP Project', commandId: randomUUID(),
    } })
    expect(collision.isError).toBe(true)
    expect(await readdir(parentPath)).toContain('Picker folder')
    expect((await client.callTool({ name: 'workspace_folder_rename', arguments: {
      creationCommandId: randomUUID(), name: 'Not owned', commandId: randomUUID(),
    } })).isError).toBe(true)

    const undoInput = { creationCommandId: automaticInput.commandId, commandId: randomUUID() }
    const undone = await call('workspace_folder_undo', c.WorkspaceFolderUndoResultSchema, undoInput)
    expect(undone.value.path).toBe(renamed.value.path)
    expect(await readdir(parentPath)).not.toContain('Named folder')
    expect((await call('workspace_folder_undo', c.WorkspaceFolderUndoResultSchema, undoInput)).replayed).toBe(true)
    // A fresh command cannot undo the same creation again or target someone else's receipt.
    expect((await client.callTool({ name: 'workspace_folder_undo', arguments: { ...undoInput, commandId: randomUUID() } })).isError).toBe(true)
    const ownerClient = await connect(owner.token)
    expect((await ownerClient.callTool({ name: 'workspace_folder_undo', arguments: { creationCommandId: secondInput.commandId, commandId: randomUUID() } })).isError).toBe(true)
    await mkdir(join(second.value.path, 'keep'))
    expect((await client.callTool({ name: 'workspace_folder_undo', arguments: { creationCommandId: secondInput.commandId, commandId: randomUUID() } })).isError).toBe(true)
    expect(await readdir(second.value.path)).toContain('keep')
    const assigned = (await call('workspace_create', c.ManagedWorkspaceCommandResultSchema, { name: 'Assigned folder test', commandId: randomUUID() })).value
    await call('workspace_location_set', c.WorkspaceLocationSetResultSchema, {
      workspaceId: assigned.workspace.id, commandId: randomUUID(), expectedLocationRevision: assigned.locationRevision,
      runnerId: 'runner-local', rootPath: folder.value.path,
    })
    expect((await client.callTool({ name: 'workspace_folder_undo', arguments: { creationCommandId: folderInput.commandId, commandId: randomUUID() } })).isError).toBe(true)
    expect(await readdir(parentPath)).toContain('Picker folder')
    const disposableInput = { parentPath, name: 'Undo without naming', commandId: randomUUID() }
    await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, disposableInput)
    await call('workspace_folder_undo', c.WorkspaceFolderUndoResultSchema, { creationCommandId: disposableInput.commandId, commandId: randomUUID() })
    expect((await call('workspace_folders_list', c.HarnessDirectoryBrowseResultSchema)).directories.map((entry) => entry.name)).not.toContain('Undo without naming')
    const replacedInput = { parentPath, name: 'Replaced folder', commandId: randomUUID() }
    const replaced = await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, replacedInput)
    await rename(replaced.value.path, replaced.value.path + ' original')
    await mkdir(replaced.value.path)
    expect((await client.callTool({ name: 'workspace_folder_undo', arguments: {
      creationCommandId: replacedInput.commandId, commandId: randomUUID(),
    } })).isError).toBe(true)
    expect(await readdir(parentPath)).toContain('Replaced folder')
    const defaultsInput = { parentPath, name: 'Defaults folder', commandId: randomUUID() }
    const defaultsFolder = await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, defaultsInput)
    const changedDefaults = await call('workspace_defaults_update', c.WorkspaceDefaultsUpdateResultSchema, {
      commandId: randomUUID(), expectedRevision: savedDefaults.revision,
      value: { ...savedDefaults.value, parentPath: defaultsFolder.value.path },
    })
    expect((await client.callTool({ name: 'workspace_folder_undo', arguments: {
      creationCommandId: defaultsInput.commandId, commandId: randomUUID(),
    } })).isError).toBe(true)
    await call('workspace_defaults_update', c.WorkspaceDefaultsUpdateResultSchema, {
      commandId: randomUUID(), expectedRevision: changedDefaults.value.revision, value: savedDefaults.value,
    })

    const menuFolder = (await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, {
      parentPath, name: 'Menu folder', commandId: randomUUID(),
    })).value
    const menuRenamed = await call('workspace_folder_rename', c.WorkspaceFolderRenameResultSchema, {
      path: menuFolder.path, name: 'Menu renamed', commandId: randomUUID(),
    })
    expect(await readdir(parentPath)).toContain('Menu renamed')
    const deleteInput = { paths: [menuRenamed.value.path, second.value.path, folder.value.path], commandId: randomUUID() }
    const deleted = await call('workspace_folders_delete', c.WorkspaceFolderDeleteResultSchema, deleteInput)
    expect(deleted.value.deleted).toEqual([menuRenamed.value.path])
    expect(deleted.value.failed.map((item) => item.path)).toEqual(expect.arrayContaining([second.value.path, folder.value.path]))
    expect(await readdir(parentPath)).not.toContain('Menu renamed')
    expect(await readdir(second.value.path)).toContain('keep')
    expect((await call('workspace_folders_delete', c.WorkspaceFolderDeleteResultSchema, deleteInput)).replayed).toBe(true)
    expect((await client.callTool({ name: 'workspace_folders_delete', arguments: { paths: [parentPath], commandId: randomUUID() } })).isError).toBe(true)
    expect((await client.callTool({ name: 'workspace_folder_rename', arguments: { path: parentPath, name: 'Root rename', commandId: randomUUID() } })).isError).toBe(true)

    await call('workspace_update', c.ManagedWorkspaceCommandResultSchema, { workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision, name: 'Renamed project' })
    expect((await call('workspace_get', c.ManagedWorkspaceSchema, { workspaceId })).workspace.name).toBe('Renamed project')
    const alternate = join(parentPath, 'alternate'); await mkdir(alternate)
    await call('workspace_location_set', c.WorkspaceLocationSetResultSchema, {
      workspaceId, commandId: randomUUID(), expectedLocationRevision: workspace.locationRevision, runnerId: 'runner-local', rootPath: alternate,
    })
    expect((await call('workspace_get', c.ManagedWorkspaceSchema, { workspaceId })).executionLocation?.rootPath).toBe(alternate)
    const workflowDefaults = await call('workflow_defaults_get', c.ManagedWorkflowDefaultsSchema)
    await call('workflow_defaults_update', c.WorkflowDefaultsUpdateResultSchema, { commandId: randomUUID(), expectedRevision: workflowDefaults.revision, value: { approvalHandler: 'user' } })
    const workflow = (await call('workflow_create', current.SavedManagedWorkflowCommandResultSchema, { workspaceId, commandId: randomUUID(), name: 'MCP Workflow' })).value
    const workflowId = workflow.workflow.id
    expect(workflow.workflow.approval?.handler).toBe('user')
    const renamedWorkflow = (await call('workflow_update', current.SavedManagedWorkflowCommandResultSchema, {
      workspaceId, workflowId, commandId: randomUUID(), expectedRevision: workflow.revision, name: 'Renamed workflow',
    })).value
    const agentInput = { workspaceId, agentId: 'parity-agent', name: 'Coder', productRole: 'coder',
      configuration: { harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' } }
    // An Agent's Foreman Code MCP tools stay within its role: Orchestrator-only tools are refused for a Coder.
    const refusedTools = await client.callTool({ name: 'agent_create', arguments: { ...agentInput, commandId: randomUUID(), graphqlTools: ['interaction_respond'] } })
    expect(refusedTools.isError).toBe(true)
    expect(JSON.stringify(refusedTools.content)).toContain('GRAPHQL_TOOL_NOT_ALLOWED_FOR_ROLE')
    const agent = (await call('agent_create', c.AgentMutationResultSchema, {
      ...agentInput, commandId: randomUUID(), graphqlTools: ['context_get'],
    })).value.agent
    expect(agent.graphqlTools).toEqual(['context_get'])
    expect((await pool.query<{ tools: unknown }>(`select record->'graphqlTools' as tools from agent_configuration_versions where id=$1`,
      [agent.configurationVersionId])).rows[0]?.tools).toEqual(['context_get'])
    const saveInput = { workspaceId, workflowId, executionSemanticsVersion: 3, commandId: randomUUID(),
      expectedRevision: renamedWorkflow.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: { [agent.id]: agent.configurationVersionId },
      graph: { ...renamedWorkflow.workflow, entryNodeId: 'parity-node', nodes: [{ id: 'parity-node', agentId: agent.id, name: 'Coder',
        graphqlTools: { add: ['interaction_list'], remove: [] } }],
        edges: [], approval: { handler: 'user' }, executionCondition: { kind: 'manual', description: 'Operator managed' },
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 5 } } }
    const outsideRole = structuredClone(saveInput)
    outsideRole.commandId = randomUUID()
    outsideRole.graph.nodes[0]!.graphqlTools = { add: ['interaction_respond' as 'interaction_list'], remove: [] }
    const outsideSave = await client.callTool({ name: 'workflow_save_v3', arguments: outsideRole })
    expect(outsideSave.isError).toBe(true)
    expect(JSON.stringify(outsideSave.content)).toContain('outside its Agent role: interaction_respond')
    const saved = await call('workflow_save_v3', current.CurrentWorkflowSaveResultSchema, saveInput)
    expect((await call('workflow_save_v3', current.CurrentWorkflowSaveResultSchema, saveInput)).replayed).toBe(true)
    const exact = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, { workspaceId, workflowId,
      workflowVersionId: saved.value.currentVersionId })
    expect(exact.version).toEqual(saved.value.version)
    expect(agentWorkflowNode(exact.version.definition.nodes[0]).graphqlTools).toEqual({ add: ['interaction_list'], remove: [] })
    const readback = await call('workflow_get', current.SavedManagedWorkflowSchema, { workspaceId, workflowId })
    expect(readback.workflow.name).toBe('Renamed workflow')
    expect(readback.workflow.executionPolicy?.maxNodeExecutions).toBe(5)
    expect(readback.workflow.nodes).toHaveLength(1)
    expect(readback.workflow.executionCondition.description).toBe('Operator managed')
    const restricted = await access.issue({ name: 'No provisioning', audience: 'operator',
      grants: [{ actions: ['workspaces:create'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const limited = await connect(restricted.token)
    expect((await limited.listTools()).tools.map((tool) => tool.name)).not.toContain('workspace_folder_create')
    expect((await limited.listTools()).tools.map((tool) => tool.name)).not.toContain('workspace_folder_undo')
    expect((await limited.listTools()).tools.map((tool) => tool.name)).not.toContain('workspace_folders_delete')
    await expectMcpAccessDenied(limited.callTool({ name: 'workspace_folders_delete', arguments: { paths: [folder.value.path], commandId: randomUUID() } }))
    await expectMcpAccessDenied(limited.callTool({ name: 'workspace_folder_undo', arguments: { ...undoInput, commandId: randomUUID() } }))
    const readOnly = await access.issue({ name: 'Workflow reader', audience: 'operator',
      grants: [{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [workspaceId] } }],
      expiresAt: new Date(Date.now() + 60000) })
    const workflowReader = await connect(readOnly.token)
    expect((await workflowReader.callTool({ name: 'workflow_save_v3', arguments: { ...saveInput, commandId: randomUUID() } })).isError).toBe(true)
    expect((await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, { workspaceId, workflowId })).version).toEqual(saved.value.version)
    const denied = await limited.callTool({ name: 'workspace_create', arguments: { ...create, name: 'Denied', commandId: randomUUID() } })
    expect(denied.isError).toBe(true)
    expect(await readdir(parentPath)).not.toContain('Denied')
    await expectMcpAccessDenied(limited.callTool({ name: 'workflow_create', arguments: { workspaceId, commandId: randomUUID(), name: 'Denied workflow' } }))
    expect((await pool.query("select count(*)::int as count from management_audit where source='mcp' and outcome='succeeded'")).rows[0].count).toBeGreaterThan(5)
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await app.close(); await pool.end()
    await dropFixtureSchema(admin, schema); await admin.end()
    await removeFixtureDirectory(directory)
  }
}, 30_000)
