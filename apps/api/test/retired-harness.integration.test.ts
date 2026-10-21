import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, HarnessDefaultsSchema } from '@foreman-code/contracts'
import { AgentCreateInputSchema, ManagedAgentDetailSchema, HarnessCatalogSchema, HarnessCatalogResultSchema } from '@foreman-code/contracts/management'
import {
  SavedRunDetailsSchema, RUN_INSPECTION_TOOLS, CANONICAL_RUN_GRAPH_MCP_TOOLS,
  RunRecordDetailSchema, RunExecutionsPageSchema, RunVersionDetailSchema,
  RunExecutionDetailSchema, RunExecutionBindingsPageSchema,
  canonicalGraphJson, SavedWorkflowVersionSchema, SavedRunVersionSnapshotSchema,
} from '@foreman-code/contracts/wave25'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const historicalConfiguration = {
  harness: 'opencode', model: 'saved-provider/model', variant: 'max', nativeAgent: 'build',
  thinking: true, autoApprove: false,
}

it('rejects OpenCode creation through authenticated HTTP and MCP without persisting an Agent', async () => {
  const f = await currentOperatorIntegration({ agentManagement: true })
  try {
    const workspaceId = f.f.scope.workspaceId
    const agentId = randomUUID()
    const input = { workspaceId, agentId, commandId: randomUUID(), name: 'Retired harness choice',
      configuration: historicalConfiguration }
    const tool = (await f.client.listTools()).tools.find(tool => tool.name === 'agent_create')
    expect(tool).toBeDefined()
    const rejected = AgentCreateInputSchema.safeParse(input)
    expect(rejected.success).toBe(false)
    if (rejected.success) throw new Error('The retired harness was accepted as a new choice')
    expect(rejected.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.arrayContaining(['configuration']) }),
    ]))
    const response = await f.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/agents`,
      headers: { authorization: `Bearer ${f.writer.token}` }, payload: input })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST', details: {
      issues: expect.arrayContaining([expect.objectContaining({ path: expect.arrayContaining(['configuration']) })]),
    } } })
    const result = await f.client.callTool({ name: 'agent_create',
      arguments: { ...input, commandId: randomUUID() } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringMatching(/configuration|harness/i) }),
    ]))
    expect((await f.db.pool.query('select id from agents where id=$1', [agentId])).rows).toEqual([])
    expect((await f.db.pool.query('select id from agent_configuration_versions where agent_id=$1', [agentId])).rows)
      .toEqual([])

    const reader = await f.access.issue({ name: 'Read-only retired-harness caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agents:read', 'harnesses:read'], scope: { workspaceIds: [workspaceId] } }] })
    const readClient = await f.connect(reader.token)
    await expectMcpAccessDenied(readClient.callTool({ name: 'agent_create',
      arguments: { ...input, configuration: DEFAULT_HARNESS_DEFAULTS.codex } }))
    const denied = await f.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/agents`,
      headers: { authorization: `Bearer ${reader.token}` },
      payload: { ...input, configuration: DEFAULT_HARNESS_DEFAULTS.codex } })
    expect(denied.statusCode).toBe(403)
    const choices = await f.client.callTool({ name: 'harness_list', arguments: {} })
    expect(choices.isError).not.toBe(true)
    expect(decodeMcpToolResult(choices)).toMatchObject({ items: expect.not.arrayContaining([
      expect.objectContaining({ harness: 'opencode' }),
    ]) })
    const listed = await f.app.inject({ method: 'GET', url: '/api/management/harnesses',
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).not.toContainEqual(expect.objectContaining({ harness: 'opencode' }))
  } finally {
    await f.close()
  }
}, 60_000)

it('discovers only configured Codex and Claude through HTTP and MCP with persisted defaults and denied callers', async () => {
  const f = await currentOperatorIntegration()
  try {
    const settings = new PostgresSettingsRepository(f.db.pool)
    const presets = HarnessDefaultsSchema.parse({ ...DEFAULT_HARNESS_DEFAULTS, claude: {
      harness: 'claude', model: 'fixture-claude-model', authMode: 'subscription', configDirectory: f.db.directory,
      permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '', mcpServers: {},
    } })
    await settings.saveHarnessDefaults(presets)
    const before = await settings.getManagedHarnessDefaults()
    const mcp = await f.client.callTool({ name: 'harness_list', arguments: {} })
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true)
    const items = HarnessCatalogResultSchema.parse(decodeMcpToolResult(mcp)).items
    expect(items.map(entry => entry.harness)).toEqual(['codex', 'claude'])
    const http = await f.app.inject({ method: 'GET', url: '/api/management/harnesses',
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(http.statusCode, http.body).toBe(200)
    expect(HarnessCatalogSchema.parse(http.json())).toEqual(items)
    const denied = await f.access.issue({ name: 'Caller without harness discovery access', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['settings:read'], scope: {} }] })
    const deniedClient = await f.connect(denied.token)
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'harness_list', arguments: {} }))
    const forbidden = await f.app.inject({ method: 'GET', url: '/api/management/harnesses',
      headers: { authorization: `Bearer ${denied.token}` } })
    expect(forbidden.statusCode).toBe(403)
    expect(await settings.getManagedHarnessDefaults()).toEqual(before)
  } finally { await f.close() }
}, 60_000)

it('reads saved OpenCode Agent and Run facts through HTTP and MCP without rewriting them', async () => {
  const f = await currentOperatorIntegration({ agentManagement: true, graphReads: true })
  try {
    const entry = f.f.version.definition.nodes.find((node) => node.id === f.f.version.entryNodeId)
    if (!entry) throw new Error('The history fixture needs an Agent entry')
    const executionId = randomUUID()
    const owner = await f.runs.acquireOwnership(f.f.run.id, () => undefined)
    if (!owner) throw new Error('The history fixture could not acquire its Run')
    try {
      const admitted = await f.runs.admitRepeatExecution({ nodeId: entry.id, occurrence: null }, () => ({
        id: executionId, runId: f.f.run.id, workflowNodeId: entry.id, agentId: entry.agentId,
        agentConfigurationVersionId: f.f.version.agentConfigurationVersionIds[entry.agentId]!,
        attempt: 1, input: {}, state: 'queued', createdAt: new Date().toISOString(),
      }), owner)
      expect(admitted.kind).toBe('admitted')
    } finally { await owner.release() }
    const executionBefore = (await f.db.pool.query('select record from harness_executions where id=$1', [executionId])).rows[0]
    const configuration = f.f.configurations[0]!
    const historical = { ...configuration, harness: historicalConfiguration }
    await f.db.pool.query('update agent_configuration_versions set record=$2::jsonb where id=$1',
      [configuration.id, JSON.stringify(historical)])
    const snapshots = async () => (await f.db.pool.query<{ configuration: unknown; version: unknown; run: unknown }>(
      `select c.record as configuration, v.record as version, r.record as run
       from agent_configuration_versions c, workflow_versions v, runs r
       where c.id=$1 and v.id=$2 and r.id=$3`, [configuration.id, f.f.version.id, f.f.run.id])).rows[0]!
    const before = await snapshots()
    const args = { workspaceId: f.f.scope.workspaceId, agentId: configuration.agentId }
    const result = await f.client.callTool({ name: 'agent_get', arguments: args })
    expect(result.isError).not.toBe(true)
    const saved = ManagedAgentDetailSchema.parse(decodeMcpToolResult(result))
    expect(saved.agent.harnessConfiguration).toEqual(historicalConfiguration)
    const http = await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${args.workspaceId}/agents/${args.agentId}`,
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(http.statusCode).toBe(200)
    expect(ManagedAgentDetailSchema.parse(http.json())).toEqual(saved)
    const version = await new PostgresWorkflowRepository(f.db.pool).getVersion(f.f.version.id)
    expect(version).toEqual(f.f.version)
    const run = await f.client.callTool({ name: 'run_get',
      arguments: { workspaceId: args.workspaceId, runId: f.f.run.id, detail: 'full' } })
    expect(run.isError, JSON.stringify(run.content)).not.toBe(true)
    const details = SavedRunDetailsSchema.parse(decodeMcpToolResult(run))
    const visibleRun = { ...f.f.run }
    delete visibleRun.authorizationPrincipalId
    expect(details.run).toEqual(visibleRun)
    expect(details.run.agentConfigurationVersionIds[configuration.agentId]).toBe(historical.id)
    expect(details.executions).toEqual([executionBefore.record])
    const runHttp = await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${args.workspaceId}/runs/${f.f.run.id}`,
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(runHttp.statusCode).toBe(200)
    expect(SavedRunDetailsSchema.parse(runHttp.json())).toEqual(details)
    const configHttp = await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${args.workspaceId}/agents/${args.agentId}/versions/${historical.id}`,
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(configHttp.statusCode).toBe(200)
    expect(configHttp.json()).toEqual({ version: historical })
    const denied = await f.access.issue({ name: 'Run history caller outside the workspace', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['unrelated-workspace'] } }] })
    const deniedClient = await f.connect(denied.token)
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'run_get',
      arguments: { workspaceId: args.workspaceId, runId: f.f.run.id, detail: 'full' } }))
    const deniedHttp = await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${args.workspaceId}/runs/${f.f.run.id}`,
      headers: { authorization: `Bearer ${denied.token}` } })
    expect(deniedHttp.statusCode).toBe(403)
    const runArgs = { workspaceId: args.workspaceId, runId: f.f.run.id }
    const runUrl = `/api/management/workspaces/${args.workspaceId}/runs/${f.f.run.id}`
    const inspection = [
      { name: RUN_INSPECTION_TOOLS.record, suffix: 'record', schema: RunRecordDetailSchema },
      { name: RUN_INSPECTION_TOOLS.executions, suffix: 'executions', schema: RunExecutionsPageSchema },
      { name: RUN_INSPECTION_TOOLS.version, suffix: 'version', schema: RunVersionDetailSchema },
      { name: RUN_INSPECTION_TOOLS.execution, suffix: `executions/${executionId}`, schema: RunExecutionDetailSchema },
      { name: RUN_INSPECTION_TOOLS.bindings, suffix: `executions/${executionId}/bindings`, schema: RunExecutionBindingsPageSchema },
    ]
    for (const { name, suffix, schema } of inspection) {
      const input = name === RUN_INSPECTION_TOOLS.execution || name === RUN_INSPECTION_TOOLS.bindings
        ? { ...runArgs, executionId } : runArgs
      const httpRead = await f.app.inject({ method: 'GET', url: `${runUrl}/${suffix}`,
        headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(httpRead.statusCode, httpRead.body).toBe(200)
      const mcpRead = await f.client.callTool({ name, arguments: input })
      expect(mcpRead.isError, JSON.stringify(mcpRead.content)).not.toBe(true)
      expect(schema.parse(decodeMcpToolResult(mcpRead))).toEqual(schema.parse(httpRead.json()))
      await expectMcpAccessDenied(deniedClient.callTool({ name, arguments: input }))
      const forbidden = await f.app.inject({ method: 'GET', url: `${runUrl}/${suffix}`,
        headers: { authorization: `Bearer ${denied.token}` } })
      expect(forbidden.statusCode).toBe(403)
    }
    const record = await f.services.runs.inspection.record(f.writer.principal, runArgs)
    expect(record.run).toEqual(visibleRun)
    expect((await f.services.runs.inspection.version(f.writer.principal, runArgs)).version).toEqual(f.f.version)
    expect((await f.services.runs.inspection.executionDetail(f.writer.principal, { ...runArgs, executionId })).acceptedResult)
      .toEqual({ status: 'not_accepted' })
    expect((await f.services.runs.inspection.bindings(f.writer.principal, { ...runArgs, executionId })).items).toEqual([])
    await expect(f.runs.getRepeatSnapshot(f.f.run.id)).rejects.toThrow()
    const graphArgs = { protocolVersion: 1, scope: f.f.scope }
    const graphUrl = `/api/workspaces/${args.workspaceId}/workflows/${f.f.run.workflowId}/runs/${f.f.run.id}/graph/v1`
    for (const kind of ['snapshot', 'current', 'events'] as const) {
      const input = kind === 'events' ? { ...graphArgs, afterSequence: '0' } : graphArgs
      const query = `workflowVersionId=${f.f.version.id}&executionSemanticsVersion=3${kind === 'events' ? '&afterSequence=0' : ''}`
      const httpRead = await f.app.inject({ method: 'GET', url: `${graphUrl}/${kind}?${query}`,
        headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(httpRead.statusCode, httpRead.body).toBe(200)
      const mcpRead = await f.client.callTool({ name: CANONICAL_RUN_GRAPH_MCP_TOOLS[kind], arguments: input })
      expect(mcpRead.isError, JSON.stringify(mcpRead.content)).not.toBe(true)
      expect(decodeMcpToolResult(mcpRead)).toEqual(httpRead.json())
      const forbiddenMcp = await deniedClient.callTool({ name: CANONICAL_RUN_GRAPH_MCP_TOOLS[kind], arguments: input })
      expect(forbiddenMcp.isError).toBe(true)
      expect(JSON.stringify(forbiddenMcp.content)).toContain('GRAPH_READ_ACCESS_DENIED')
      const forbiddenHttp = await f.app.inject({ method: 'GET', url: `${graphUrl}/${kind}?${query}`,
        headers: { authorization: `Bearer ${denied.token}` } })
      expect(forbiddenHttp.statusCode).toBe(403)
    }
    expect(await snapshots()).toEqual(before)
    expect((await f.db.pool.query('select record from harness_executions where id=$1', [executionId])).rows[0]).toEqual(executionBefore)
  } finally {
    await f.close()
  }
}, 60_000)

it.each(['physical Agent mismatch', 'duplicate configuration pins'] as const)('rejects historical readback with %s', async (corruption) => {
  const f = await currentOperatorIntegration({ agentManagement: true, graphReads: true })
  try {
    const workspaceId = f.f.scope.workspaceId
    let runId = f.f.run.id
    let workflowVersionId = f.f.version.id
    const configuration = f.f.configurations[0]!
    if (corruption === 'physical Agent mismatch') {
      const foreignAgentId = randomUUID()
      const created = await f.client.callTool({ name: 'agent_create', arguments: {
        workspaceId, agentId: foreignAgentId, commandId: randomUUID(), name: 'Unpinned Agent',
        configuration: DEFAULT_HARNESS_DEFAULTS.codex,
      } })
      expect(created.isError, JSON.stringify(created.content)).not.toBe(true)
      const malformed = { ...configuration, agentId: foreignAgentId, version: 999, harness: historicalConfiguration }
      await f.db.pool.query('update agent_configuration_versions set agent_id=$2, version=$3, record=$4::jsonb where id=$1',
        [configuration.id, foreignAgentId, malformed.version, JSON.stringify(malformed)])
    } else {
      const pins = Object.fromEntries(Object.keys(f.f.version.agentConfigurationVersionIds).map(id => [id, configuration.id]))
      const revision = f.f.version.version + 1
      const version = { ...f.f.version, id: randomUUID(), version: revision,
        definition: { ...f.f.version.definition, version: revision },
        agentConfigurationVersionIds: pins }
      version.contentHash = `sha256:${createHash('sha256').update(canonicalGraphJson({
        definition: version.definition, configurations: pins, entryNodeId: version.entryNodeId,
      })).digest('hex')}`
      const run = { ...f.f.run, id: randomUUID(), workflowVersionId: version.id, agentConfigurationVersionIds: pins }
      SavedWorkflowVersionSchema.parse(version)
      SavedRunVersionSnapshotSchema.parse({ run, version })
      // Seed malformed saved facts as new rows; existing version and Run pins remain immutable.
      await f.db.pool.query(`insert into workflow_versions
        (id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
        values($1,$2,$3,$4,$5,3,$6::jsonb)`,
      [version.id, workspaceId, version.workflowId, version.version, version.entryNodeId, JSON.stringify(version)])
      await f.db.pool.query(`insert into runs
        (id,workspace_id,workflow_id,workflow_version_id,execution_state,record,runner_id,working_directory,location_revision)
        values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [run.id, workspaceId, run.workflowId, version.id, run.executionState, JSON.stringify(run),
        run.executionLocation!.runnerId, run.executionLocation!.rootPath, run.executionLocation!.locationRevision])
      await f.db.pool.query(`insert into run_graph_heads(run_id,protocol_version,history_coverage)
        values($1,1,'from_snapshot')`, [run.id])
      runId = run.id
      workflowVersionId = version.id
    }
    const snapshots = async () => (await f.db.pool.query(`select c.agent_id,c.record as configuration,
      v.record as version,r.record as run from agent_configuration_versions c,workflow_versions v,runs r
      where c.id=$1 and v.id=$2 and r.id=$3`, [configuration.id, workflowVersionId, runId])).rows[0]
    const before = await snapshots()
    const runArgs = { workspaceId, runId }
    for (const [name, suffix] of [['run_get', ''], [RUN_INSPECTION_TOOLS.record, '/record']] as const) {
      const http = await f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${workspaceId}/runs/${runId}${suffix}`,
        headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(http.statusCode).toBe(409)
      expect(http.json()).toMatchObject({ error: { code: 'AGENT_CONFIGURATION_UNAVAILABLE' } })
      const mcp = await f.client.callTool({ name, arguments: runArgs })
      expect(mcp.isError).toBe(true)
      expect(JSON.stringify(mcp.content)).toContain('AGENT_CONFIGURATION_UNAVAILABLE')
    }
    const graph = await f.client.callTool({ name: CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot,
      arguments: { protocolVersion: 1, scope: { ...f.f.scope, runId, workflowVersionId } } })
    expect(graph.isError).toBe(true)
    expect(JSON.stringify(graph.content)).toContain('GRAPH_INVARIANT_VIOLATION')
    const graphHttp = await f.app.inject({ method: 'GET',
      url: `/api/workspaces/${workspaceId}/workflows/${f.f.run.workflowId}/runs/${runId}/graph/v1/snapshot?workflowVersionId=${workflowVersionId}&executionSemanticsVersion=3`,
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(graphHttp.statusCode).toBe(409)
    expect(graphHttp.json()).toMatchObject({ error: { code: 'GRAPH_INVARIANT_VIOLATION' } })
    expect(await snapshots()).toEqual(before)
  } finally { await f.close() }
}, 60_000)
