import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { afterEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../src/app.js'
import { workerToolServices } from './helpers/workerMcpServices.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })
async function setup() {
  const f = await approvalDatabase(); closes.push(f.close)
  const tools = workerToolServices(f.pool, f.commands)
  const { bugReports, ci } = tools
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    appMcp: tools.appMcp(f.access, new PostgresAppInteractionService(f.pool, f.repository, f.commands, f.service)),
    operator: { access: f.access, services: { commands: f.commands, ci, bugReports } as never } })
  const origin = await app.listen({ host: '127.0.0.1', port: 0 }); closes.push(() => app.close())
  async function connect(path: string, token: string) {
    const client = new Client({ name: 'a4-authenticated-regression', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(path, origin), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
    await client.connect(transport); closes.push(() => client.close())
    return client
  }
  return { ...f, app, connect, writes: () => f.counts().responses }
}

describe.skipIf(!postgresEnabled)('A4 authenticated App MCP with persisted PostgreSQL readback', { timeout: 60000 }, () => {
  it('App response records one scoped decision; exact replay is safe and no native delivery is inferred', async () => {
    const f = await setup()
    const client = await f.connect('/mcp', f.credential.environment.variables.GRAPHQL_MCP_TOKEN!)
    const tools = await client.listTools()
    expect(tools.tools.some((tool) => tool.name === 'interaction_respond')).toBe(true)
    expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['files.references_list', 'files.reference_read']))
    const references = await client.callTool({ name: 'files.references_list', arguments: {} })
    expect(references.isError).not.toBe(true)
    expect(references.structuredContent).toMatchObject({ items: [], pageInfo: { nextCursor: null } })
    const args = { interactionId: f.interaction.id, optionId: f.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId, expectedRevision: f.interaction.revision }
    const first = await client.callTool({ name: 'interaction_respond', arguments: args })
    expect(first.isError).not.toBe(true)
    expect((await f.repository.get(f.interaction.id))?.deliveryState).toBe('pending')
    const replay = await client.callTool({ name: 'interaction_respond', arguments: args })
    expect(replay.isError).not.toBe(true)
    const get = await client.callTool({ name: 'interaction_get', arguments: { interactionId: f.interaction.id } })
    expect(get.isError).not.toBe(true)
    expect(JSON.stringify(decodeMcpToolResult(get))).toContain(args.optionId)
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(f.interaction.revision + 1)
    expect(f.writes()).toBe(0)
    const conflict = await client.callTool({ name: 'interaction_respond', arguments: { ...args, optionId: 'reject' } })
    expect(conflict.isError).toBe(true)
    expect((await f.pool.query("select * from management_audit where principal_id=$1 and action='interaction_respond'", [f.principal.id])).rowCount).toBeGreaterThanOrEqual(2)
  })
  it('a read-only or revoked App principal cannot decide through MCP', async () => {
    const f = await setup()
    await f.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.principal.id, JSON.stringify([
      { actions: ['interactions:read'], scope: { workspaceIds: [f.run.workspaceId], workflowIds: [f.run.workflowId], runIds: [f.run.id] } },
    ])])
    const client = await f.connect('/mcp', f.credential.environment.variables.GRAPHQL_MCP_TOKEN!)
    expect((await client.listTools()).tools.some((tool) => tool.name === 'interaction_respond')).toBe(false)
    const denied = await client.callTool({ name: 'interaction_respond', arguments: { interactionId: f.interaction.id, optionId: f.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId, expectedRevision: f.interaction.revision } }).catch(() => ({ isError: true }))
    expect(denied.isError).toBe(true)
    await f.credentials.revoke({ principalId: f.principal.id })
    const revoked = await client.callTool({ name: 'interaction_get', arguments: { interactionId: f.interaction.id } }).catch(() => ({ isError: true }))
    expect(revoked.isError).toBe(true)
    expect((await f.repository.get(f.interaction.id))?.status).toBe('pending')
  })
})
