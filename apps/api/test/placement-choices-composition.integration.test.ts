import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildProductionApp } from '../src/production.js'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { ProductionPlacementChoiceDiscovery } from '../src/modules/placement/choiceDiscovery.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

/** Real production composition, PostgreSQL and bearer MCP; destination inventory is synthetic, with no native execution. */
describe.skipIf(!postgresEnabled)('saved placement discovery and clearing through the production server', () => {
  it.each(['codex', 'claude'] as const)('%s choices honor MCP grants and persisted readback', async harness => {
    const db = await currentDatabase()
    const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! })
    config.harnesses.workspaceRoot = join(db.directory, 'runtime')
    const checkpoints = createCheckpointStore(config.database.connectionString, 'placement_choices', config.database)
    const clients: Client[] = []
    let production: ReturnType<typeof buildProductionApp> | undefined
    try {
      const mainId = (await db.pool.query('select id from application_installation')).rows[0].id
      const placement = SavedNodePlacementSchema.parse({ schemaVersion: 1, hostRef: { kind: 'main', mainId },
        rootPolicyId: 'approved-root', rootPolicyRevision: '1', locationRevision: '1', projectRoot: db.directory,
        cwdPolicy: 'project-root', relativeCwd: '', instanceId: 'profile', instanceRevision: '1',
        harnessInstallationId: 'installed-harness' })
      const initial = makeCurrentWorkflowFixture(randomUUID(), 'single')
      if (harness === 'claude') {
        initial.configurations[0]!.harness = { harness: 'claude', model: 'claude-haiku-4-5', authMode: 'subscription',
          configDirectory: '/home/operator/.claude', permissionMode: 'default', sandbox: 'danger-full-access',
          tools: ['Read', 'Write'], permissionRules: [], instructions: '', mcpServers: {} }
      }
      initial.version.definition.nodes[0]!.placement = placement
      const fixture = await seedAgent3(db.pool, db.directory, initial, { run: false })
      const input = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
        nodeId: fixture.version.definition.nodes[0]!.id, agentConfigurationVersionId: fixture.configurations[0]!.id }
      const choices = [{ id: 'approved-main-choice', label: `Main · ${harness}`, placement,
        availability: 'ready' as const, reason: null }, ...(harness === 'claude' ? [{
          id: 'unsupported-worker-claude', label: 'Worker · claude',
          placement: { ...placement, hostRef: { kind: 'device' as const, mainId, deviceId: randomUUID() } },
          availability: 'unavailable' as const,
          reason: 'This harness does not support workflow execution on this computer.',
        }] : [])]
      const discovery = vi.spyOn(ProductionPlacementChoiceDiscovery.prototype, 'list').mockResolvedValue({ choices, pending: false })
      const access = new PostgresAccessService(db.pool)
      const owner = await access.issue({ name: 'Placement owner', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      const denied = await access.issue({ name: 'Placement reader without paths', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['workflows:read'],
          scope: { workspaceIds: [input.workspaceId] } }] })
      production = buildProductionApp(config, { pool: db.pool, ping: async () => { await db.pool.query('select 1') },
        migrate: async () => {}, close: db.close }, checkpoints, false)
      const address = await production.app.listen({ host: '127.0.0.1', port: 0 })
      async function connect(token: string) {
        const client = new Client({ name: 'placement-composition', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      const operator = await connect(owner.token)
      const deniedOperator = await connect(denied.token)
      const path = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/nodes/${input.nodeId}/placement-choices?agentConfigurationVersionId=${input.agentConfigurationVersionId}`
      const headers = { authorization: `Bearer ${owner.token}` }
      const http = await production.app.inject({ method: 'GET', url: path, headers })
      expect(http.statusCode, http.body).toBe(200)
      expect(http.json()).toEqual({ ...input, choices, pending: false })
      const mcp = await operator.callTool({ name: 'workflow_node_placement_choices', arguments: input })
      expect(mcp.isError).not.toBe(true)
      expect(decodeMcpToolResult(mcp)).toEqual(http.json())
      if (harness === 'claude') {
        expect(decodeMcpToolResult(mcp).choices).toContainEqual(expect.objectContaining({
          availability: 'unavailable', reason: 'This harness does not support workflow execution on this computer.',
          placement: expect.objectContaining({ hostRef: expect.objectContaining({ kind: 'device' }) }),
        }))
      }
      const deniedHttp = await production.app.inject({ method: 'GET', url: path,
        headers: { authorization: `Bearer ${denied.token}` } })
      expect(deniedHttp.statusCode).toBe(403)
      expect((await deniedOperator.callTool({ name: 'workflow_node_placement_choices', arguments: input })).isError).toBe(true)
      expect(discovery).toHaveBeenCalledTimes(2)
      const audit = await db.pool.query<{ source: string }>(
        "select source from management_audit where principal_id=$1 and outcome='denied'", [denied.principal.id],
      )
      expect(audit.rows).toEqual(expect.arrayContaining([{ source: 'http' }, { source: 'mcp' }]))

      const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
      const saved = await operator.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })
      const before = CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(saved))
      expect(before.version.agentConfigurationVersionIds).toEqual(fixture.version.agentConfigurationVersionIds)
      const configuration = (await db.pool.query('select record from agent_configuration_versions where id=$1',
        [input.agentConfigurationVersionId])).rows[0].record
      expect(configuration.harness).toEqual(fixture.configurations[0]!.harness)
      const savedNode = before.version.definition.nodes[0]!
      if (savedNode.kind === 'job') throw new Error('Expected the saved Agent node.')
      expect(savedNode.placement).toEqual(placement)
      const graph = structuredClone(before.version.definition)
      const node = graph.nodes[0]!
      if (node.kind === 'job') throw new Error('Expected the saved Agent node.')
      delete node.placement
      const saveInput = { ...scope, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: before.revision, expectedWorkflowVersionId: before.currentVersionId,
        expectedAgentConfigurationVersionIds: before.version.agentConfigurationVersionIds, graph }
      const cleared = await operator.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: saveInput })
      expect(cleared.isError, JSON.stringify(cleared)).not.toBe(true)
      const result = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(cleared))
      const readback = await operator.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })
      const after = CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(readback))
      expect(after.currentVersionId).toBe(result.value.currentVersionId)
      expect(after.version.definition.nodes[0]).not.toHaveProperty('placement')
      const persisted = (await db.pool.query('select record from workflow_versions where id=$1',
        [after.currentVersionId])).rows[0].record
      expect(persisted.definition.nodes[0]).not.toHaveProperty('placement')
      const historical = (await db.pool.query('select record from workflow_versions where id=$1',
        [before.currentVersionId])).rows[0].record
      expect(historical.definition.nodes[0].placement).toEqual(placement)
      const retry = await operator.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: saveInput })
      expect(CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(retry)).value).toEqual(result.value)
      await db.pool.query('update management_principals set revoked_at=now() where id=$1', [owner.principal.id])
      expect((await production.app.inject({ method: 'GET', url: path, headers })).statusCode).toBe(401)
    } finally {
      await Promise.all(clients.map(client => client.close()))
      await production?.app.close()
      await checkpoints.close()
      vi.restoreAllMocks()
      await db.close()
    }
  }, 120_000)
})
