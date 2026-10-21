import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { WorkflowChatPostResponseSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { seedAgent3 } from './helpers/wave25Agent3.js'
import { access, address, database, project, production, registerProductionLifecycleFixture } from './helpers/productionLifecycleFixture.js'

registerProductionLifecycleFixture()

it('composes group chat in production with authenticated posting, persisted readback and denied writes', async () => {
  const saved = await seedAgent3(database.pool, project, makeCurrentWorkflowFixture('group-production', 'single'), { run: false })
  const scope = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId }
  const issued = await access.issue({ name: 'Group sender', audience: 'operator', grants: [{
    scope: { workspaceIds: [scope.workspaceId], workflowIds: [scope.workflowId] },
    actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'capabilities:read'],
  }] })
  const client = new Client({ name: 'Group composition client', version: '1' })
  const deniedClient = new Client({ name: 'Group read only client', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => issued.token },
    }))
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('workflow_chat_post')
    const request = { ...scope, commandId: randomUUID(), body: 'Production group chat', mentions: [], deliveries: [], cardIds: [] }
    const response = await client.callTool({ name: 'workflow_chat_post', arguments: request })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    const posted = WorkflowChatPostResponseSchema.parse(decodeMcpToolResult(response))
    const read = await client.callTool({ name: 'workflow_chat_read', arguments: scope })
    expect(decodeMcpToolResult(read)).toMatchObject({ items: [posted.post] })
    const http = await production.app.inject({ url: `/api/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/chat`,
      headers: { authorization: `Bearer ${issued.token}` } })
    expect(http.statusCode, http.body).toBe(200)
    expect(http.json()).toMatchObject({ items: [posted.post] })
    const denied = await access.issue({ name: 'Group reader', audience: 'operator', grants: [{
      scope: { workspaceIds: [scope.workspaceId] }, actions: ['agent_chat:read'],
    }] })
    await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => denied.token },
    }))
    const refusal = await deniedClient.callTool({ name: 'workflow_chat_post', arguments: { ...request, commandId: randomUUID() } })
    expect(refusal.isError).toBe(true)
    expect(decodeMcpToolResult(await client.callTool({ name: 'workflow_chat_read', arguments: scope })))
      .toMatchObject({ items: [posted.post] })
  } finally {
    await deniedClient.close()
    await client.close()
  }
})
