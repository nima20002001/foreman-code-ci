import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { MAX_FILE_WRITE_BYTES } from '@foreman-code/contracts/files'
import { requireLocalRequest } from '../../access/http.js'
import { DomainError } from '../../errors.js'
import { toolFailure } from '../../../mcp/shared/results.js'
import { ALL_FILE_TOOL_NAMES, type FileToolOperation } from './types.js'
import { createFileMcpServer, type FileMcpService } from './mcpServer.js'
export { createFileMcpServer, type FileMcpService } from './mcpServer.js'
export const FILE_TOOLS_MCP_PATH = '/mcp/files'
const bearer = (header: string | undefined) => /^Bearer (gql_file_[A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1]
const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.string() }).passthrough() }).passthrough()
/** Separate authenticated surface, not the workflow /mcp server or an Operator credential exchange. */
export function registerFileToolsMcp(app: FastifyInstance, service: FileMcpService): void {
  // Authenticate before buffering the larger, still bounded base64 request body.
  app.post(FILE_TOOLS_MCP_PATH, { bodyLimit: 4 * Math.ceil(MAX_FILE_WRITE_BYTES / 3) + 512 * 1024,
    onRequest: async (request) => {
      requireLocalRequest(request)
      await (service.sessions.authenticateSharedEndpoint ?? service.sessions.discover ?? service.sessions.authenticate).call(
        service.sessions, bearer(request.headers.authorization))
    },
  }, async (request, reply) => {
    requireLocalRequest(request)
    const token = bearer(request.headers.authorization)
    await (service.sessions.authenticateSharedEndpoint ?? service.sessions.discover ?? service.sessions.authenticate).call(
      service.sessions, token)
    const call = ToolCall.safeParse(request.body)
    if (call.success && ALL_FILE_TOOL_NAMES.includes(call.data.params.name as FileToolOperation)) {
      const name = call.data.params.name as FileToolOperation
      try { await service.sessions.authenticate(token, name) }
      catch (error) {
        if (!(error instanceof DomainError) || error.status !== 403) throw error
        return reply.send({ jsonrpc: '2.0', id: call.data.id, result: toolFailure(error) })
      }
    }
    const server = await createFileMcpServer(service, token!)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
    reply.header('cache-control', 'no-store')
    await server.connect(transport)
    reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  for (const method of ['GET', 'DELETE'] as const) app.route({ method, url: FILE_TOOLS_MCP_PATH,
    handler: async (request, reply) => {
      requireLocalRequest(request)
      await (service.sessions.authenticateSharedEndpoint ?? service.sessions.authenticate).call(
        service.sessions, bearer(request.headers.authorization))
      return reply.code(405).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } })
    } })
}
