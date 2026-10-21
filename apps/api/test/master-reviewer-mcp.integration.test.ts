import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ExecutableWorkflowV3Schema } from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { workerToolServices } from './helpers/workerMcpServices.js'

it.skipIf(!postgresEnabled)('preserves the Master identity and designated reviewer authority through authenticated MCP', async () => {
  const f = await approvalDatabase({ reviewerRole: 'master' })
  const tools = workerToolServices(f.pool, f.commands)
  const app = buildApp({
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    appMcp: tools.appMcp(f.access, new PostgresAppInteractionService(f.pool, f.repository, f.commands, f.service)),
    operator: { access: f.access, services: {
      commands: f.commands, ci: tools.ci, bugReports: tools.bugReports,
    } as OperatorServices },
  })
  const clients: Client[] = []
  try {
    expect(ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.f.configurations }).version)
      .toEqual(f.version)
    expect(f.version.definition.hierarchy?.masterNodeId).toBe(f.version.entryNodeId)
    expect(f.run).not.toHaveProperty('resultProtocol')
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'master-reviewer-context', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const master = await connect(f.credential.environment.variables.GRAPHQL_MCP_TOKEN!)
    const context = await master.callTool({ name: 'context_get', arguments: {} })
    expect(context.isError, JSON.stringify(context)).not.toBe(true)
    expect(context.structuredContent).toEqual(decodeMcpToolResult(context))
    expect(decodeMcpToolResult(context)).toMatchObject({
      role: 'master', principal: { audience: 'worker', agentId: f.reviewer.agentId },
      capabilities: { contextGet: true, interactionList: true, interactionGet: true, interactionRespond: true },
    })
    const masterTools = (await master.listTools()).tools.map(tool => tool.name)
    expect(masterTools).toContain('interaction_respond')
    expect(masterTools).toEqual(expect.arrayContaining([
      'ci_run', 'ci_get', 'ci_computers_list', 'ci_cancel', 'ci_logs_read',
    ]))
    expect(masterTools).not.toContain('memory_board_get')

    const requesterCredential = await f.credentials.issueForExecution(f.requester.id)
    const coder = await connect(requesterCredential.environment.variables.GRAPHQL_MCP_TOKEN!)
    const coderContext = await coder.callTool({ name: 'context_get', arguments: {} })
    expect(coderContext.isError, JSON.stringify(coderContext)).not.toBe(true)
    expect(decodeMcpToolResult(coderContext)).toMatchObject({ role: 'coder',
      capabilities: { interactionRespond: false } })
    expect((await coder.listTools()).tools.map(tool => tool.name)).not.toContain('interaction_respond')
    const input = approvalResponse(f.interaction)
    const refused = await coder.callTool({ name: 'interaction_respond', arguments: input })
    expect(refused.isError).toBe(true)
    const errorText = refused.content.find(item => item.type === 'text')
    if (!errorText || typeof errorText.text !== 'string') throw new Error('Expected an MCP error response')
    expect(JSON.parse(errorText.text)).toMatchObject({ error: { code: 'ROLE_NOT_ALLOWED' } })
    expect(await f.repository.get(input.interactionId)).toMatchObject({
      status: 'pending', revision: f.interaction.revision,
    })

    const accepted = await master.callTool({ name: 'interaction_respond', arguments: input })
    expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true)
    expect(decodeMcpToolResult(accepted)).toMatchObject({ interaction: { deliveryState: 'pending' } })
    const stored = await f.repository.get(input.interactionId)
    expect(stored).toMatchObject({ id: input.interactionId, revision: f.interaction.revision + 1,
      deliveryState: 'pending' })
    const readback = await master.callTool({ name: 'interaction_get', arguments: { interactionId: input.interactionId } })
    expect(readback.isError, JSON.stringify(readback)).not.toBe(true)
    expect(decodeMcpToolResult(readback)).toMatchObject({ interaction: {
      id: input.interactionId, revision: stored!.revision, deliveryState: 'pending',
    } })
    expect(f.counts().responses).toBe(0)

    const invalid = await app.inject({ method: 'POST', url: '/mcp', headers: {
      authorization: 'Bearer invalid', accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_get', arguments: {} } } })
    expect(invalid.statusCode).toBe(401)
    expect((await f.repository.get(input.interactionId))?.revision).toBe(stored!.revision)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    try { await app.close() } finally { await f.close() }
  }
}, 60_000)
