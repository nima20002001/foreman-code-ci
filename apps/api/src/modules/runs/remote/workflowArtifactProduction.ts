import { settleObserved } from '../../diagnostics/ignoredError.js'
import { isDeepStrictEqual } from 'node:util'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import { WorkflowArtifactTransferInputSchema } from '@foreman-code/contracts/workflow-artifact-transfer'
import { z, ZodError } from 'zod'
import type { WorkerArtifactMcpExtension } from '../../../mcp/unified/transport.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { DomainError } from '../../errors.js'
import { createProductionDistributedArtifacts } from '../../files/production.js'
import { registerDistributedArtifacts, type DistributedArtifactEndpointAuthorization } from '../../files/distributed/adapters.js'
import { createWorkflowArtifactReceiver } from './workflowArtifactReceiver.js'
import type { PostgresArtifactPublicationAuthority } from './nativeArtifactAuthority.js'

const names = ['files.admit_transferred_result', 'files.publish_transferred_result', 'files.read_edge_input'] as const
const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]), method: z.literal('tools/call'),
  params: z.object({ name: z.string(), arguments: z.unknown().optional() }).passthrough() }).passthrough()
const denied = () => new DomainError('WORKFLOW_ARTIFACT_TOOL_DENIED', 'This original workflow does not authorize the requested artifact tool.', 403)
const denial = (error: unknown) => error instanceof ZodError || error instanceof DomainError && error.status >= 400 && error.status < 500

export function mountProductionWorkflowArtifacts(input: Parameters<typeof createWorkflowArtifactReceiver>[0] & {
  app: FastifyInstance; files: Parameters<typeof createProductionDistributedArtifacts>[0]['files'];
  attempts: Parameters<typeof createProductionDistributedArtifacts>[0]['attempts'];
  authority: PostgresArtifactPublicationAuthority;
  commands: Pick<PostgresCommandCoordinator, 'recordDenied'>
}) {
  const receiver = createWorkflowArtifactReceiver(input)
  const artifacts = createProductionDistributedArtifacts({ ...input, authority: input.authority,
    readAuthority: { authorize: (accepted, sql) => input.authority.authorizePublication(accepted, sql) },
    transfers: receiver.reader })
  // onRequest, the shared handler and the extension may all resample authority.
  // One denied request retains one audit, without copying its credential.
  const audited = new WeakSet<FastifyRequest>()
  const audit = async (request: FastifyRequest, name: string, principal?: ManagementPrincipal) => {
    if (audited.has(request)) return
    principal ??= await receiver.authorization.authenticate(request).catch(() => { /* ignore: a failed authentication leaves the principal unset and the denial is recorded below */ return undefined })
    await input.commands.recordDenied(principal?.id, request.url.startsWith('/mcp') ? 'mcp' : 'http', name, `artifact:${name}`)
    audited.add(request)
  }
  const authorize = async <T>(request: FastifyRequest, operation: string, work: () => Promise<T>): Promise<T> => {
    try { return await work() } catch (error) { if (denial(error)) await audit(request, operation); throw error }
  }
  const publisher = async (request: FastifyRequest) => {
    const accepted = await receiver.authorization.producer(request)
    if (!accepted.context.allowMutation || !accepted.context.allowedTools.includes('files.publish_result')) throw denied()
    return accepted
  }
  const consumer = async (request: FastifyRequest) => {
    const caller = await receiver.authorization.consumer(request), accepted = await receiver.authorization.producer(request)
    if (!isDeepStrictEqual(caller.attempt, accepted.attempt) || !accepted.context.allowedTools.includes('files.read')) throw denied()
    return caller
  }
  const auth: DistributedArtifactEndpointAuthorization = {
    producer: request => authorize(request, 'files.publish_transferred_result', () => publisher(request)),
    consumer: request => authorize(request, 'files.read_edge_input', () => consumer(request)),
  }
  const endpoints: Readonly<Record<string, string>> = { '/mcp/artifact-transfers': names[0],
    '/mcp/artifact-publications': names[1], '/mcp/artifact-inputs': names[2] }
  input.app.addHook('preHandler', async (request, reply) => {
    const expected = endpoints[request.routeOptions.url ?? ''], call = ToolCall.safeParse(request.body)
    if (expected && call.success && call.data.params.name !== expected) {
      await audit(request, call.data.params.name)
      return reply.send({ jsonrpc: '2.0', id: call.data.id, result: toolFailure(denied()) })
    }
  })
  const actions = registerDistributedArtifacts(input.app, artifacts.edges, artifacts.publications, auth)
  const admit = (request: FastifyRequest, raw: unknown, source: 'http' | 'mcp') =>
    authorize(request, names[0], () => receiver.admit(request, WorkflowArtifactTransferInputSchema.parse(raw), source))
  const registerTransferTool = (server: McpServer, request: FastifyRequest) => {
    server.registerTool(names[0], { inputSchema: WorkflowArtifactTransferInputSchema, outputSchema: TransferIntentSchema,
      description: 'Admit immutable artifact bytes for this original workflow worker before sending ID-only byte frames. Rechecks the original native context, device, owner, saved file tools and sandbox.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async raw => { try { return toolResult(await admit(request, raw, 'mcp')) } catch (error) { return toolFailure(error) } })
  }
  input.app.post('/api/artifact-transfers', { bodyLimit: 4096, onRequest: async request => { await auth.producer(request) } },
    async (request, reply) => { reply.header('cache-control', 'no-store'); return admit(request, request.body, 'http') })
  input.app.post('/mcp/artifact-transfers', { bodyLimit: 16384, onRequest: async request => { await auth.producer(request) } }, async (request, reply) => {
    const server = new McpServer({ name: 'graphql-artifact-transfers', version: '1.0.0' })
    registerTransferTool(server, request)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.raw.once('close', () => { void settleObserved('http', 'close disconnected MCP resources', [transport.close(), server.close()]) })
    reply.header('cache-control', 'no-store'); await server.connect(transport); reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  const permission = async (request: FastifyRequest, name: string) => {
    if (name === names[2]) await consumer(request)
    else await publisher(request)
  }
  const extension: WorkerArtifactMcpExtension = {
    async register(server, request, principal) {
      if (principal.audience !== 'worker') return
      const accepted = await receiver.authorization.producer(request).catch(async error => {
        if (!denial(error)) throw error
        await audit(request, 'workflow_artifact_discovery', principal); return undefined
      })
      if (!accepted) return
      if (accepted.context.allowedTools.includes('files.read')) {
        try { await permission(request, names[2]); actions.registerInputTool(server, request) }
        catch (error) { if (!denial(error)) throw error; await audit(request, 'workflow_artifact_discovery', principal) }
      }
      if (accepted.context.allowMutation && accepted.context.allowedTools.includes('files.publish_result')) {
        registerTransferTool(server, request); actions.registerPublicationTool(server, request)
      }
    },
    async call(request, principal, body) {
      const call = ToolCall.safeParse(body)
      if (!call.success || !call.data.params.name.startsWith('files.')) return undefined
      const name = call.data.params.name
      try {
        if (principal.audience !== 'worker' || !names.some(candidate => candidate === name)) throw denied()
        await permission(request, name)
        const raw = call.data.params.arguments
        const result = name === names[0] ? await admit(request, raw, 'mcp')
          : name === names[1] ? await actions.publish(request, raw, 'mcp') : await actions.read(request, raw)
        return { jsonrpc: '2.0', id: call.data.id, result: toolResult(result) }
      } catch (error) {
        if (denial(error)) await audit(request, name, principal)
        return { jsonrpc: '2.0', id: call.data.id, result: toolFailure(error) }
      }
    },
  }
  return { receiver, artifacts, extension }
}
