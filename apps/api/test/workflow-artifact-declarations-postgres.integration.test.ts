import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { AgentSchema, AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema, CurrentWorkflowReadResultSchema } from '@foreman-code/contracts/wave25'
import { currentRunHistory } from './helpers/currentRunHistory.js'
import { registerOperatorHttpSecurity, requireLocalRequest } from '../src/modules/access/http.js'
import { bearerToken } from '../src/modules/access/postgres.js'
import { registerCurrentWorkflowRoutes } from '../src/routes/currentWorkflow.js'
import { registerCurrentWorkflowTools } from '../src/mcp/operator/tools/currentWorkflow.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { DomainError } from '../src/modules/errors.js'

/** Actual SQL saved-version writer and authenticated production HTTP/MCP handlers.
 * This verifies declarations only; no native qualification, output or edge is fabricated. */
describe.skipIf(!process.env.TEST_DATABASE_URL)('saved workflow artifact declaration parity', () => {
  it('retains exact optional fields, original history and idempotence, with denied scoped/read-only/revoked callers', async () => {
    const f = await currentRunHistory(), app = Fastify(), clients: Client[] = []
    try {
      const managed = (await f.workflows.create(f.owner.principal, 'mcp', { workspaceId: f.f.scope.workspaceId,
        name: 'Saved artifact declarations', commandId: randomUUID() })).value
      registerOperatorHttpSecurity(app, f.access)
      registerCurrentWorkflowRoutes(app, f.workflows)
      app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
        .send({ error: { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Request failed.' } }))
      app.post('/mcp', async (request, reply) => {
        requireLocalRequest(request)
        const principal = await f.access.authenticate(bearerToken(request.headers.authorization), 'operator')
        const server = new McpServer({ name: 'artifact-declaration-parity', version: '1' })
        registerCurrentWorkflowTools(server, { principal, services: { workflows: f.workflows, commands: f.commands } as unknown as OperatorServices })
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
        await server.connect(transport); reply.hijack(); await transport.handleRequest(request.raw, reply.raw, request.body)
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      async function connect(token: string) {
        const client = new Client({ name: 'artifact-declaration-readback', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
        return client
      }
      const owner = await connect(f.owner.token), source = f.saved.value.version.definition.nodes[0]!
      if (source.kind === 'job') throw new Error('Agent fixture required')
      const peerConfiguration = AgentConfigurationVersionSchema.parse({ ...f.f.configurations[0]!, id: randomUUID(), agentId: randomUUID() })
      const peer = AgentSchema.parse({ id: peerConfiguration.agentId, name: 'Artifact consumer fixture', productRole: peerConfiguration.productRole,
        configurationVersionId: peerConfiguration.id, harnessConfiguration: peerConfiguration.harness })
      await f.db.pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)', [peer.id, peerConfiguration.workspaceId, JSON.stringify(peer)])
      await f.db.pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)',
        [peerConfiguration.id, peerConfiguration.workspaceId, peer.id, JSON.stringify(peerConfiguration)])
      await f.db.pool.query('update agents set current_configuration_version_id=$2 where id=$1', [peer.id, peerConfiguration.id])
      const artifact = { version: 1 as const, outputKeys: ['report'] }
      const scope = { workspaceId: f.f.scope.workspaceId, workflowId: managed.workflow.id }
      const path = `/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/definition`
      const graph = { ...managed.workflow, entryNodeId: 'producer', approval: f.saved.value.version.approval,
        nodes: [{ ...source, id: 'producer', artifactOutputs: artifact }, { ...source, id: 'consumer', agentId: peer.id }],
        edges: [{ id: 'forward', kind: 'execution' as const, source: 'producer', target: 'consumer', artifactInputs: artifact }],
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 2 } }
      const input = { ...scope, commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: managed.revision,
        expectedWorkflowVersionId: null, expectedAgentConfigurationVersionIds: { ...f.saved.value.version.agentConfigurationVersionIds, [peer.id]: peerConfiguration.id },
        graph }
      const tools = await owner.listTools()
      const saveTool = tools.tools.find(tool => tool.name === CURRENT_WORKFLOW_TOOLS.save)!
      expect(JSON.stringify(saveTool.inputSchema)).toContain('artifactOutputs')
      expect(JSON.stringify(saveTool.inputSchema)).toContain('artifactInputs')
      expect(saveTool.description).toContain('canonical publication proof')
      const savedCall = await owner.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input })
      expect(savedCall.isError, JSON.stringify(savedCall)).not.toBe(true)
      const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedCall))
      expect(saved.value.version.definition.nodes[0]).toMatchObject({ artifactOutputs: artifact })
      expect(saved.value.version.definition.edges[0]).toMatchObject({ artifactInputs: artifact })
      const retry = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult((await owner.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input }))))
      expect(retry.value).toEqual(saved.value); expect(retry.replayed).toBe(true)
      const headers = { authorization: `Bearer ${f.owner.token}` }
      const http = await app.inject({ method: 'GET', url: path, headers })
      expect(http.statusCode, http.body).toBe(200)
      const mcpRead = await owner.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })
      expect(mcpRead.isError).not.toBe(true)
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(mcpRead))).toEqual(http.json())
      const editedArtifact = { version: 1 as const, outputKeys: ['report_v2'] }
      const edit = { ...input, commandId: randomUUID(), expectedRevision: saved.value.revision, expectedWorkflowVersionId: saved.value.currentVersionId,
        graph: { ...saved.value.version.definition, nodes: [{ ...graph.nodes[0]!, artifactOutputs: editedArtifact }, graph.nodes[1]!],
          edges: [{ ...graph.edges[0]!, artifactInputs: editedArtifact }] } }
      const editedHttp = await app.inject({ method: 'PUT', url: path, headers, payload: edit })
      expect(editedHttp.statusCode, editedHttp.body).toBe(200)
      const edited = CurrentWorkflowSaveResultSchema.parse(editedHttp.json())
      expect(edited.value.currentVersionId).not.toBe(saved.value.currentVersionId)
      expect(edited.value.version.contentHash).not.toBe(saved.value.version.contentHash)
      const historical = await owner.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: { ...scope, workflowVersionId: saved.value.currentVersionId } })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(historical)).version).toEqual(saved.value.version)
      const foreign = await f.access.issue({ name: 'Foreign workspace writer', audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
        grants: [{ actions: f.owner.principal.grants[0]!.actions, scope: { workspaceIds: ['foreign-workspace'] } }] })
      const foreignClient = await connect(foreign.token)
      expect((await foreignClient.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: { ...edit, commandId: randomUUID() } })).isError).toBe(true)
      expect((await foreignClient.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })).isError).toBe(true)
      expect((await app.inject({ method: 'PUT', url: path, headers: { authorization: `Bearer ${foreign.token}` }, payload: edit })).statusCode).toBe(403)
      expect((await f.db.pool.query("select count(*)::int as count from management_audit where principal_id=$1 and source='mcp' and outcome='denied'", [foreign.principal.id])).rows[0].count).toBeGreaterThanOrEqual(2)
      const readOnly = await f.access.issue({ name: 'Read-only workflow reader', audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
        grants: [{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [scope.workspaceId] } }] })
      const reader = await connect(readOnly.token)
      expect((await reader.listTools()).tools.some(tool => tool.name === CURRENT_WORKFLOW_TOOLS.save)).toBe(false)
      expect((await app.inject({ method: 'PUT', url: path, headers: { authorization: `Bearer ${readOnly.token}` }, payload: edit })).statusCode).toBe(403)
      const readerResult = await reader.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(readerResult)).version).toEqual(edited.value.version)
      await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [f.owner.principal.id])
      await expect(owner.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })).rejects.toThrow()
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult((await reader.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })))).version).toEqual(edited.value.version)
      expect((await f.db.pool.query('select record from workflow_versions where id=$1', [saved.value.currentVersionId])).rows[0].record).toEqual(saved.value.version)
    } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close(); await f.db.close() }
  }, 60_000)
})
