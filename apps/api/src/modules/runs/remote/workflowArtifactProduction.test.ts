import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import type { FastifyRequest } from 'fastify'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ArtifactAttempt } from '@foreman-code/contracts/artifact-edges'
import type { AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import { DomainError } from '../../errors.js'
import { registerGraphqlMcp } from '../../../mcp/unified/transport.js'
const ports = vi.hoisted(() => ({ receiver: vi.fn(), artifacts: vi.fn() }))
vi.mock('./workflowArtifactReceiver.js', () => ({ createWorkflowArtifactReceiver: ports.receiver }))
vi.mock('../../files/production.js', () => ({ createProductionDistributedArtifacts: ports.artifacts }))
import { mountProductionWorkflowArtifacts } from './workflowArtifactProduction.js'
const apps: ReturnType<typeof Fastify>[] = []
beforeEach(() => vi.clearAllMocks())
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
function fixture(write = false) {
  // Common HTTP/MCP wiring with explicit authority/storage boundary doubles.
  // This cannot prove actual SQL, native residency, transferred bytes or grants.
  const app = Fastify(); apps.push(app)
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: error instanceof Error ? error.message : 'error' }))
  const principal: ManagementPrincipal = { id: 'original-worker', name: 'Worker', audience: 'worker', agentId: 'agent', grants: [], revokedAt: null, expiresAt: '2099-01-01T00:00:00.000Z' }
  const attempt: ArtifactAttempt = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', nodeId: 'node',
    executionId: 'execution', attemptId: randomUUID(), placementHash: 'a'.repeat(64) }
  const accepted = { attempt, context: { allowMutation: write, allowedTools: ['files.read', 'files.publish_result'],
    scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: 'original-context', workspaceId: 'workspace', workflowId: 'workflow',
      runId: 'run', executionId: 'execution', agentId: 'agent' } } } } as AcceptedArtifactPublication
  const auth = { authenticate: vi.fn(async () => principal), producer: vi.fn(async () => accepted),
    consumer: vi.fn(async () => ({ attempt, authority: { principalId: 'owner', grantId: 'grant', grantRevision: '1' } })) }
  const receiver = { authorization: auth, reader: {}, admit: vi.fn(async () => ({ transferId: randomUUID() })), close: vi.fn() }
  const artifacts = { edges: { readAccepted: vi.fn(async () => ({ original: 'edge-read' })) },
    publications: { publishAccepted: vi.fn(async () => ({ original: 'publication' })) } }
  ports.receiver.mockReturnValue(receiver); ports.artifacts.mockReturnValue(artifacts)
  const commands = { recordDenied: vi.fn(async () => undefined) }
  const mounted = mountProductionWorkflowArtifacts({ app, commands } as unknown as Parameters<typeof mountProductionWorkflowArtifacts>[0])
  const request = { url: '/mcp', headers: { authorization: 'Bearer unit-worker' } } as FastifyRequest
  const registerTool = vi.fn(), server = { registerTool } as unknown as McpServer
  const call = (name: string, args: unknown = {}) => mounted.extension.call(request, principal,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  return { app, principal, accepted, attempt, auth, receiver, artifacts, commands, mounted, request, server, registerTool, call }
}
it.each([false, true])('discovers only actual saved read/mutation capabilities (write=%s)', async write => {
  const f = fixture(write); await f.mounted.extension.register(f.server, f.request, f.principal)
  expect(f.registerTool.mock.calls.map(call => call[0])).toEqual(write
    ? ['files.read_edge_input', 'files.admit_transferred_result', 'files.publish_transferred_result'] : ['files.read_edge_input'])
  expect(f.auth.consumer).toHaveBeenCalledWith(f.request)
})
it.each(['wrong-purpose', 'revoked-context'])('does not advertise or deliver with %s', async reason => {
  const f = fixture(true)
  f.auth.producer.mockRejectedValue(new DomainError('WORKFLOW_ARTIFACT_DENIED', reason, 403))
  await f.mounted.extension.register(f.server, f.request, f.principal)
  expect(f.registerTool).not.toHaveBeenCalled()
  const result = await f.call('files.admit_transferred_result')
  expect(result).toMatchObject({ result: { isError: true } })
  expect(f.receiver.admit).not.toHaveBeenCalled()
  expect(f.commands.recordDenied).toHaveBeenCalled()
})
it.each(['files.admit_transferred_result', 'files.publish_transferred_result', 'files.destroy_transferred_result'])('denies and audits direct read-only/unknown %s', async name => {
  const f = fixture()
  expect(await f.call(name)).toMatchObject({ result: { isError: true } })
  expect(f.commands.recordDenied).toHaveBeenCalledExactlyOnceWith(f.principal.id, 'mcp', name, `artifact:${name}`)
  expect(f.receiver.admit).not.toHaveBeenCalled(); expect(f.artifacts.publications.publishAccepted).not.toHaveBeenCalled()
})
it('requires genuine consumer authority separately from the publisher context', async () => {
  const f = fixture(true); f.auth.consumer.mockRejectedValue(new DomainError('WORKFLOW_ARTIFACT_DENIED', 'consumer denied', 403))
  await f.mounted.extension.register(f.server, f.request, f.principal)
  expect(f.registerTool.mock.calls.map(call => call[0])).toEqual(['files.admit_transferred_result', 'files.publish_transferred_result'])
  expect(await f.call('files.read_edge_input', { edgeId: randomUUID(), offset: 0, length: 3 })).toMatchObject({ result: { isError: true } })
  expect(f.artifacts.edges.readAccepted).not.toHaveBeenCalled()
})
it('reuses the original standalone consumer/edge handler for a permitted direct read', async () => {
  const f = fixture(), edgeId = randomUUID()
  expect(await f.call('files.read_edge_input', { edgeId, offset: 0, length: 3 })).toMatchObject({ result: { structuredContent: { original: 'edge-read' } } })
  expect(f.artifacts.edges.readAccepted).toHaveBeenCalledExactlyOnceWith(edgeId, f.attempt,
    { principalId: 'owner', grantId: 'grant', grantRevision: '1' }, 0, 3)
})
it('preserves standalone HTTP read and rejects standalone mutation under the same saved policy', async () => {
  const f = fixture(), edgeId = randomUUID()
  const read = await f.app.inject({ method: 'POST', url: '/api/artifact-inputs/read', payload: { edgeId, offset: 0, length: 3 } })
  expect(read.statusCode).toBe(200); expect(read.json()).toEqual({ original: 'edge-read' })
  const write = await f.app.inject({ method: 'POST', url: '/api/artifact-transfers', payload: { commandId: 'original-command', sha256: 'a'.repeat(64), byteSize: 3 } })
  expect(write.statusCode).toBe(403); expect(f.receiver.admit).not.toHaveBeenCalled()
  expect(f.commands.recordDenied).toHaveBeenCalled()
})
it('admits declarations before bytes with the actual HTTP request and original command', async () => {
  const f = fixture(true), input = { commandId: 'original-command', sha256: 'a'.repeat(64), byteSize: 3 }
  const result = await f.app.inject({ method: 'POST', url: '/api/artifact-transfers', payload: input })
  expect(result.statusCode).toBe(200)
  expect(f.receiver.admit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: '/api/artifact-transfers' }), input, 'http')
})
it('preserves the original standalone publication command and accepted context', async () => {
  const f = fixture(true), transferId = randomUUID()
  const publication = { commandId: 'original-publication-command', artifactId: 'original-artifact',
    scope: f.accepted.context.scope, filename: 'result.md', mediaType: 'text/markdown' }
  const response = await f.app.inject({ method: 'POST', url: '/api/artifact-publications', payload: { transferId, publication } })
  expect(response.statusCode).toBe(200)
  expect(f.artifacts.publications.publishAccepted).toHaveBeenCalledExactlyOnceWith(f.accepted, transferId, publication, 'http')
})
it('adds no graph-tool grants while advertising the authorized extension through actual /mcp', async () => {
  const f = fixture()
  registerGraphqlMcp(f.app, { access: { authenticate: async () => f.principal } as unknown as Parameters<typeof registerGraphqlMcp>[1]['access'],
    interactions: { toolAccess: async () => ({ role: 'coder', tools: ['context_get'] }), canRead: async () => false, canRespond: async () => false } as unknown as NonNullable<Parameters<typeof registerGraphqlMcp>[1]['interactions']>,
    workerArtifacts: () => f.mounted.extension })
  const response = await f.app.inject({ method: 'POST', url: '/mcp', headers: { host: '127.0.0.1', authorization: 'Bearer unit-worker', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } })
  expect(response.statusCode).toBe(200)
  const body = response.headers['content-type']?.startsWith('text/event-stream') ? JSON.parse(/^data: (.+)$/m.exec(response.payload)![1]!) : response.json()
  // A Worker with no enabled tools is refused at discovery, so one graph tool stays enabled; the extension adds only its own read.
  expect(body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['context_get', 'files.read_edge_input'])
})
it('denies and audits undeclared names on the standalone MCP endpoint', async () => {
  const f = fixture(true)
  const response = await f.app.inject({ method: 'POST', url: '/mcp/artifact-transfers',
    headers: { accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'files.unknown', arguments: {} } } })
  expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ result: { isError: true } })
  expect(f.commands.recordDenied).toHaveBeenCalledWith(f.principal.id, 'mcp', 'files.unknown', 'artifact:files.unknown')
  expect(f.receiver.admit).not.toHaveBeenCalled()
})
