import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { z } from 'zod'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import { buildApp } from '../../app.js'
import { requireLocalRequest, registerOperatorHttpSecurity } from '../access/http.js'
import { bearerToken } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { conversationDeliveryFixture } from '../conversations/conversationDelivery.test-support.js'
import { DomainError } from '../errors.js'
import { registerAgentChatRoutes } from '../../routes/agentChat.js'
import { registerOperatorChatRoutes } from '../../routes/operatorChat.js'
import { createAgentChatTools } from '../../mcp/operator/tools/agentChat.js'
import { createOperatorControlTools, createOperatorDeliveryTools } from '../../mcp/operator/tools/operatorControls.js'
import { workflowChatTools } from '../../mcp/operator/tools/workflowChat.js'
import { registerToolDefinition, toolAvailable } from '../../mcp/operator/definition.js'
import { invokeOperatorTool } from '../../mcp/operator/invoke.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { ExecutionChatPort } from '../collaboration/ports.js'
import { ChatDeliveryRouter, type ConversationDeliveryPort } from './delivery.js'
import { LegacyChatDeliveryBridge } from './legacyBridge.js'
import { retainedExecutionFixture } from './retainedExecution.test-support.js'

const callSchema = z.object({ id: z.union([z.string(), z.number()]), method: z.literal('tools/call'),
  params: z.object({ name: z.string() }).passthrough() }).passthrough()
function unavailable(): never { throw new Error('This fixture only composes public chat services.') }

/** Real bearer authentication, HTTP routes, SDK validation, common receipts and concrete owners.
 * The C tool factories are mounted at the explicit composition seam D owns; no parallel registry is shipped. */
export async function deliveryAdaptersFixture(options: { beforeOwnerAdoption?: boolean;
  executionKind?: 'workflow_execution' | 'workflow_coordinator' } = {},
  retainedFixture?: Awaited<ReturnType<typeof conversationDeliveryFixture>>,
  retainedOwnerState?: Parameters<typeof retainedExecutionFixture>[2]) {
  const fixture = retainedFixture ?? await conversationDeliveryFixture()
  const endpoints = options.executionKind || options.beforeOwnerAdoption
    ? fixture.createServices() : { agent: fixture.agent, operator: fixture.operator }
  if (endpoints.agent !== fixture.agent) {
    endpoints.agent.createDeliveryOwner(fixture.feature.repository.deliveries)
    endpoints.operator.createDeliveryOwner(fixture.feature.repository.deliveries)
  }
  let router = fixture.feature.router, dispatchAttempts = 0
  const execution = options.executionKind ? retainedExecutionFixture(fixture, options.executionKind, retainedOwnerState) : undefined
  if (execution) {
    router = execution.router
    const bridge = new LegacyChatDeliveryBridge(router, endpoints.agent, endpoints.operator, {
      resolve: async () => execution.target,
    })
    endpoints.agent.installDeliveryBridge(bridge); endpoints.operator.installDeliveryBridge(bridge)
  }
  if (options.beforeOwnerAdoption) {
    const original = router
    const owner: ConversationDeliveryPort = {
      deliver: async () => { dispatchAttempts++; throw new DomainError('OWNER_UNAVAILABLE', 'Owner adoption is unavailable.', 503) },
      read: async (principal, request) => {
        const result = await original.read(principal, request)
        if (!('state' in result)) throw new Error('Expected a native owner readback.')
        return result
      }, stop: (principal, request) => original.stop(principal, request),
      cancel: (principal, request) => original.cancel(principal, request),
    }
    const execution: ExecutionChatPort = { deliver: async () => unavailable(), read: async () => unavailable(),
      stop: async () => unavailable(), cancel: async () => unavailable() }
    router = new ChatDeliveryRouter(original.repository, fixture.feature.targetAuthority, execution, owner, owner)
    const bridge = new LegacyChatDeliveryBridge(router, endpoints.agent, endpoints.operator, {
      resolve: async (principal, workspaceId, query) => {
        const read = await fixture.agent.read(principal, workspaceId, query)
        if (!read.deliveryTarget) throw new Error('No exact delivery target is readable.')
        return read.deliveryTarget
      },
    })
    endpoints.agent.installDeliveryBridge(bridge); endpoints.operator.installDeliveryBridge(bridge)
  }
  const commands = new PostgresCommandCoordinator(fixture.database.pool)
  const services: OperatorServices = { agentChat: endpoints.agent, operatorChat: endpoints.operator, commands,
    get workspaces() { return unavailable() }, get locations() { return unavailable() },
    get workflows() { return unavailable() }, get agents() { return unavailable() },
    get harnesses() { return unavailable() }, get runs() { return unavailable() } }
  const app = buildApp({ readiness: { database: { ping: async () => { await fixture.database.pool.query('select 1') } },
    checkpoints: { ping: async () => undefined } } })
  registerOperatorHttpSecurity(app, fixture.access)
  registerAgentChatRoutes(app, endpoints.agent)
  registerOperatorChatRoutes(app, endpoints.operator)
  const definitions = [...createAgentChatTools(router), ...createOperatorControlTools(router), ...createOperatorDeliveryTools(router),
    ...workflowChatTools(fixture.feature.service)]
  const sessions = new Set<() => Promise<void>>()
  app.addHook('preClose', async () => { await Promise.all([...sessions].map(close => close())) })
  app.post('/mcp', { onRequest: async request => {
    requireLocalRequest(request)
    await fixture.access.authenticate(bearerToken(request.headers.authorization), 'operator')
  } }, async (request, reply) => {
    const principal = await fixture.access.authenticate(bearerToken(request.headers.authorization), 'operator')
    const context = { principal, services }
    const call = callSchema.safeParse(request.body)
    const known = call.success ? definitions.find(tool => tool.name === call.data.params.name) : undefined
    if (call.success && known && !toolAvailable(context, known)) return { jsonrpc: '2.0', id: call.data.id,
      result: await invokeOperatorTool(context, known.name, async () => {
        throw new DomainError('FORBIDDEN', 'This caller cannot use that chat action.', 403)
      }, known.requires[0][0]) }
    const server = new McpServer({ name: 'chat-delivery-adapter-fixture', version: '1.0.0' })
    for (const tool of definitions.filter(value => toolAvailable(context, value))) {
      registerToolDefinition(server, context, tool, { invoke: invokeOperatorTool, tools: definitions })
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    let closing: Promise<void> | undefined
    const close = () => closing ??= Promise.all([transport.close(), server.close()]).then(() => { sessions.delete(close) })
    sessions.add(close)
    reply.raw.once('close', () => { void close().catch(error => app.log.error({ err: error }, 'MCP fixture cleanup failed')) })
    await server.connect(transport); reply.hijack()
    const handle = toNodeHandler({ fetch: (webRequest, options) => transport.handleRequest(webRequest, options) },
      { onerror: error => request.log.error({ err: error }, 'MCP fixture request failed') })
    await handle({ method: request.method, url: request.url, headers: request.raw.headers,
      [Symbol.asyncIterator]: () => request.raw[Symbol.asyncIterator]() }, reply.raw, request.body)
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const issue = (name: string, grants: ManagementGrant[] = fixture.owner.grants) => fixture.access.issue({
    name, audience: 'operator', grants, expiresAt: new Date(Date.now() + 600_000) })
  const owner = await issue('HTTP and MCP owner')
  const connect = async (token: string) => {
    const client = new Client({ name: 'chat-delivery-public-client', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    clients.push(client); return client
  }
  let closing: Promise<void> | undefined
  const closeAdapter = () => closing ??= Promise.all(clients.map(client => client.close())).then(async () => {
    await app.close()
    if (endpoints.agent !== fixture.agent) await endpoints.agent.shutdown()
    if (endpoints.operator !== fixture.operator) await endpoints.operator.shutdown()
  })
  return { fixture, app, owner, issue, connect, execution, closeAdapter, dispatchAttempts: () => dispatchAttempts,
    async close() { await closeAdapter(); await fixture.close() } }
}
