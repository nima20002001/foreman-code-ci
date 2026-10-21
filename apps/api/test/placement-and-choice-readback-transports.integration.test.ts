import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { currentRunHistory } from './helpers/currentRunHistory.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertAcceptedPlacements } from '../src/modules/placement/persistence.js'
import { freezePlacement } from '../src/modules/placement/binding.js'
import { NodePlacementChoicesService } from '../src/modules/placement/choicesService.js'
import { RunPlacementReadService } from '../src/modules/placement/readService.js'
import { registerRunPlacementRoutes, registerRunPlacementTool, registerNodePlacementChoicesRoutes, registerNodePlacementChoicesTool } from '../src/modules/placement/transports.js'
import { registerOperatorHttpSecurity, requireLocalRequest } from '../src/modules/access/http.js'
import { bearerToken } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'

/** Synthetic placement/admission fixture, real database/authenticated HTTP+MCP.
 * Orchestrator alone executes this. No real-device acceptance is implied. */
describe.skipIf(!postgresEnabled)('W08 exact accepted host readback parity', () => {
  it('persists immutable host through HTTP/MCP and denies scoped/revoked callers', async () => {
    const f = await currentRunHistory(), app = Fastify(), clients: Client[] = []
    try {
      const draft = await insertCurrentRunFixture(f.db.pool, { ...f.f, run: { ...f.run, id: randomUUID() } }, f.saved.value, f.owner.principal.id, { insert: false })
      const node = agentWorkflowNode(draft.version.definition.nodes[0]), configuration = f.f.configurations[0]!, digest = 'a'.repeat(64)
      const mainId = (await f.db.pool.query('select id from application_installation')).rows[0].id
      const deviceId = randomUUID()
      const placement = freezePlacement({ schemaVersion: 1, mainId, runId: draft.run.id, nodeId: node.id,
        hostRef: { kind: 'device', mainId, deviceId }, labelAtAcceptance: 'Original laptop', mainInstallationId: 'main-installation',
        registration: { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 },
        destination: { canonicalProjectRoot: '/approved/project', canonicalCwd: '/approved/project', managedRuntimeRoot: '/managed/runtime',
          directoryIdentityHash: digest, rootPolicyId: 'approved-root', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest },
        source: { revisionId: 'source-revision', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
        payload: { kind: 'agent', agentId: node.agentId, agentConfigurationVersionId: configuration.id,
          driverId: 'codex', driverRevision: 'driver-v1', instanceId: 'instance', instanceRevision: 'instance-v1',
          harnessInstallationId: 'installation', installationFingerprint: 'fingerprint', runtimeContractVersion: 1,
          protocolRevision: 'protocol-v1', credentialScopeRefs: [] } })
      await withExclusiveGraphConnection(f.db.pool, connection => connection.transaction(async sql => {
        await insertRepeatRun(sql, draft.accepted, repeatStartPublication)
        await insertAcceptedPlacements(sql, draft.run.id, draft.version.definition.nodes.map(agentWorkflowNode),
          draft.run.agentConfigurationVersionIds, [placement], { assertCurrent: async () => {} })
      }))
      const reads = new RunPlacementReadService(f.db.pool, async () => []) // no native work in this fixture
      const choices = new NodePlacementChoicesService(f.db.pool, { list: async () => ({ pending: false, choices: [{ id: 'approved-laptop-choice', label: 'Original laptop',
        placement: { schemaVersion: 1, hostRef: placement.hostRef, rootPolicyId: 'approved-root', rootPolicyRevision: '1', locationRevision: '1',
          projectRoot: '/approved/project', cwdPolicy: 'project-root', relativeCwd: '', instanceId: 'instance', instanceRevision: 'instance-v1', harnessInstallationId: 'installation' },
        availability: 'ready', reason: null }] }) })
      registerOperatorHttpSecurity(app, f.access)
      registerRunPlacementRoutes(app, reads)
      registerNodePlacementChoicesRoutes(app, choices)
      app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' } }))
      app.post('/mcp', async (request, reply) => {
        requireLocalRequest(request)
        const principal = await f.access.authenticate(bearerToken(request.headers.authorization), 'operator')
        const server = new McpServer({ name: 'w08-placement-auth-fixture', version: '1' })
        registerRunPlacementTool(server, reads, principal, f.commands)
        registerNodePlacementChoicesTool(server, choices, principal, f.commands)
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
        await server.connect(transport); reply.hijack()
        await transport.handleRequest(request.raw, reply.raw, request.body)
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const input = { workspaceId: draft.run.workspaceId, workflowId: draft.run.workflowId, runId: draft.run.id, nodeId: node.id }
      const path = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs/${input.runId}/nodes/${node.id}/placement`
      async function connect(token: string) {
        const client = new Client({ name: 'w08-readback', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const owner = await connect(f.owner.token)
      const http = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${f.owner.token}` } })
      expect(http.statusCode).toBe(200)
      const result = await owner.callTool({ name: 'run_node_placement_get', arguments: input })
      expect(result.isError).not.toBe(true); expect(decodeMcpToolResult(result)).toEqual(http.json())
      expect(http.json().readback).toEqual({ evidence: 'accepted', placement, observations: [] })
      const choiceInput = { workspaceId: input.workspaceId, workflowId: input.workflowId, nodeId: node.id, agentConfigurationVersionId: configuration.id }
      const choicePath = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/nodes/${node.id}/placement-choices?agentConfigurationVersionId=${configuration.id}`
      const choiceHttp = await app.inject({ method: 'GET', url: choicePath, headers: { authorization: `Bearer ${f.owner.token}` } })
      expect(choiceHttp.statusCode).toBe(200)
      const choiceMcp = await owner.callTool({ name: 'workflow_node_placement_choices', arguments: choiceInput })
      expect(choiceMcp.isError).not.toBe(true); expect(decodeMcpToolResult(choiceMcp)).toEqual(choiceHttp.json())
      expect((await choices.get(f.owner.principal, choiceInput)).choices[0]?.placement.hostRef).toEqual(placement.hostRef)
      await expect(choices.get(f.owner.principal, { ...choiceInput, agentConfigurationVersionId: 'unsaved-configuration' })).rejects.toMatchObject({ code: 'PLACEMENT_CONFIGURATION_CONFLICT' })
      await expect(f.db.pool.query("update run_node_placements set record=jsonb_set(record,'{labelAtAcceptance}','\"Edited laptop\"') where run_id=$1", [draft.run.id])).rejects.toMatchObject({ code: 'P2843' })
      const denied = await f.access.issue({ name: 'Foreign Run reader', audience: 'operator', expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['runs:read'], scope: { runIds: [f.run.id] } }] })
      const deniedClient = await connect(denied.token)
      expect((await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      expect((await deniedClient.callTool({ name: 'run_node_placement_get', arguments: input })).isError).toBe(true)
      expect((await deniedClient.callTool({ name: 'workflow_node_placement_choices', arguments: choiceInput })).isError).toBe(true)
      expect((await app.inject({ method: 'GET', url: choicePath, headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [f.owner.principal.id])
      await expect(reads.get(f.owner.principal, input)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      expect((await f.db.pool.query('select record from run_node_placements where run_id=$1', [draft.run.id])).rows[0]?.record).toEqual(placement)
    } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close(); await f.db.close() }
  }, 120_000)
})
