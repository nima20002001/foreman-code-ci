import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ArtifactEdgeReadSchema, type ArtifactAttempt, type ArtifactGrantReference } from '@foreman-code/contracts/artifact-edges'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema, AgentFileReadResultSchema } from '@foreman-code/contracts/files'
import { toolResult, toolFailure } from '../../../mcp/shared/results.js'
import type { ArtifactEdgeService } from './edges.js'
import type { AcceptedArtifactPublication, DistributedArtifactPublicationService } from './publication.js'

const Publish = z.object({ transferId: z.uuid(), publication: AgentFilePublishInputSchema }).strict()
/** Authenticator accepts only the intended W07 worker/session credential, resolving live
 * W08 ownership. It must never exchange a browser/Operator credential for worker authority. */
export interface DistributedArtifactEndpointAuthorization {
  consumer(request: FastifyRequest): Promise<{ attempt: ArtifactAttempt; authority: ArtifactGrantReference }>
  producer(request: FastifyRequest): Promise<AcceptedArtifactPublication>
}
export function createDistributedArtifactActions(edges: ArtifactEdgeService,
  publications: DistributedArtifactPublicationService, auth: DistributedArtifactEndpointAuthorization) {
  const read = async (request: FastifyRequest, raw: unknown) => {
    const caller = await auth.consumer(request), input = ArtifactEdgeReadSchema.parse(raw)
    return edges.readAccepted(input.edgeId, caller.attempt, caller.authority, input.offset, input.length)
  }
  const publish = async (request: FastifyRequest, raw: unknown, source: 'http' | 'mcp') => {
    const accepted = await auth.producer(request), input = Publish.parse(raw)
    return publications.publishAccepted(accepted, input.transferId, input.publication, source)
  }
  const registerInputTool = (server: McpServer, request: FastifyRequest) => {
    server.registerTool('files.read_edge_input', { inputSchema: ArtifactEdgeReadSchema, outputSchema: AgentFileReadResultSchema,
      description: 'Read at most 64 KiB of the exact persisted input for the authenticated accepted execution/attempt. Rechecks both sender and receiver grants and expiry.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => { try { return toolResult(await read(request, input)) } catch (error) { return toolFailure(error) } })
  }
  const registerPublicationTool = (server: McpServer, request: FastifyRequest) => {
    server.registerTool('files.publish_transferred_result', { inputSchema: Publish, outputSchema: AgentFilePublishResultSchema,
      description: 'Publish verified immutable artifact bytes through the common document validation/allocation/finalization ledger. commandId is the retry key; different content or ownership conflicts.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => { try { return toolResult(await publish(request, input, 'mcp')) } catch (error) { return toolFailure(error) } })
  }
  return { read, publish, registerInputTool, registerPublicationTool }
}
export function registerDistributedArtifacts(app: FastifyInstance, edges: ArtifactEdgeService,
  publications: DistributedArtifactPublicationService, auth: DistributedArtifactEndpointAuthorization) {
  const actions = createDistributedArtifactActions(edges, publications, auth)
  const { read, publish } = actions
  app.post('/api/artifact-inputs/read', { bodyLimit: 4096,
    onRequest: async (request) => { await auth.consumer(request) } }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return read(request, request.body)
  })
  app.post('/api/artifact-publications', { bodyLimit: 8192,
    onRequest: async (request) => { await auth.producer(request) } }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return publish(request, request.body, 'http')
  })
  app.post('/mcp/artifact-inputs', { bodyLimit: 16 * 1024,
    onRequest: async (request) => { await auth.consumer(request) } }, async (request, reply) => {
    const server = new McpServer({ name: 'graphql-artifact-inputs', version: '1.0.0' }, { instructions:
      'Accepted revision-pinned artifact inputs only. Hashes and edge IDs confer no authority. No reference editing or delegation creation.' })
    actions.registerInputTool(server, request)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
    reply.header('cache-control', 'no-store')
    await server.connect(transport); reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  app.post('/mcp/artifact-publications', { bodyLimit: 16 * 1024,
    onRequest: async (request) => { await auth.producer(request) } }, async (request, reply) => {
    const server = new McpServer({ name: 'graphql-artifact-publications', version: '1.0.0' }, { instructions:
      'Publish verified artifact transfers owned by this accepted sender. Accepted sandbox mutation permission remains required; source packages use a separate class.' })
    actions.registerPublicationTool(server, request)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
    reply.header('cache-control', 'no-store')
    await server.connect(transport); reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  return actions
}
