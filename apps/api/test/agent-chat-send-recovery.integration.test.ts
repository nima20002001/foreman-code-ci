import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, it, vi } from 'vitest'
import {
  AgentChatStateSchema,
  SendAgentChatMessageResponseSchema,
  type SendAgentChatMessageRequest,
} from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { AgentChatF5Native, eventually } from './helpers/agentChatF5.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

/** Opt-in real SQL/authenticated transports; native I/O remains a deterministic substitute. */
describe.skipIf(!postgresEnabled)('Agent chat send recovery after access revocation', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let pool: pg.Pool
  let root: string
  let fixture: ReturnType<typeof makeCurrentWorkflowFixture>
  let access: PostgresAccessService
  let writer: ManagementPrincipal
  let writerToken: string
  let readerToken: string

  beforeAll(async () => {
    database = await agent3Database()
    pool = database.pool
    root = database.directory
    fixture = await seedAgent3(pool, root, makeCurrentWorkflowFixture(`send-recovery-${randomUUID()}`, 'single'), { run: false })
    access = new PostgresAccessService(pool)
    const issued = await access.issue({ name: 'Chat writer', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond'], scope: {} }] })
    writer = issued.principal
    writerToken = issued.token
    readerToken = (await access.issue({ name: 'Chat reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: {} }] })).token
  })
  beforeEach(async () => {
    await pool.query(`delete from operator_conversations where kind='agent' and workspace_id=$1`, [fixture.scope.workspaceId])
  })
  afterAll(async () => { await database?.close() })

  async function setup() {
    const node = fixture.version.definition.nodes[0]!
    const context = {
      workspaceId: fixture.scope.workspaceId,
      workflowId: fixture.scope.workflowId,
      workflowNodeId: node.id,
      agentId: node.agentId,
    }
    const { workspaceId, ...query } = context
    const repository = new PostgresAgentChatRepository(pool)
    const managers = new Map<string, AgentChatF5Native>()
    const service = new AgentChatService(pool, repository, new PostgresOperatorConversationRepository(pool), new PostgresWorkflowRepository(pool),
      {
        getForWorkspace: async () => { throw new Error('Chat fixture must not access a Run.') },
        getExecution: async () => { throw new Error('This fixture must not read a Run execution.') },
        async *executionPages() { yield [] },
      },
      (id) => {
        const manager = new AgentChatF5Native()
        managers.set(id, manager)
        return manager
      }, root)
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'chat-send-recovery', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const mcp = await connect(writerToken)
    const reader = await connect(readerToken)
    const url = `/api/workspaces/${workspaceId}/agent-chat`
    const headers = { authorization: `Bearer ${writerToken}` }
    const message = (requestId: string, expectedConversationId: string | null): SendAgentChatMessageRequest =>
      ({ requestId, context: query, content: `Message ${requestId}`, intent: 'next_turn', expectedConversationId })
    const first = await service.send(writer, workspaceId, message('active-message', null))
    const id = first.state.conversation!.id
    await eventually(() => managers.has(id))
    const native = managers.get(id)!
    await native.started.promise
    return { workspaceId, query, repository, app, mcp, reader, url, headers, message, id, native,
      close: async () => {
        native.finish({ outcome: 'canceled' })
        await service.shutdown()
        await Promise.allSettled(clients.map((client) => client.close()))
        await app.close()
      } }
  }

  it.each(['http', 'mcp'] as const)('recovers the original receipt after a post-acceptance denial through %s', async transport => {
    const f = await setup()
    const input = f.message('accepted-before-denial', f.id)
    const originalAdmit = f.repository.admit.bind(f.repository)
    const admission = vi.spyOn(f.repository, 'admit').mockImplementationOnce(async request => {
      const result = await originalAdmit(request)
      await pool.query('update management_principals set grants=$2::jsonb where id=$1', [writer.id,
        JSON.stringify([{ actions: ['agent_chat:write'], scope: {} }])])
      return result
    })
    try {
      if (transport === 'http') {
        const denied = await f.app.inject({ method: 'POST', url: `${f.url}/messages`, headers: f.headers, payload: input })
        assert.equal(denied.statusCode, 403)
      } else {
        await expectMcpAccessDenied(f.mcp.callTool({ name: 'agent_chat_send', arguments: {
          workspaceId: f.workspaceId, request: input,
        } }))
      }
      const stored = await f.repository.turn(f.id, input.requestId)
      assert.ok(stored, 'The denied response follows persisted acceptance.')
      await pool.query('update management_principals set grants=$2::jsonb where id=$1',
        [writer.id, JSON.stringify(writer.grants)])
      await expectMcpAccessDenied(f.reader.callTool({ name: 'agent_chat_send', arguments: {
        workspaceId: f.workspaceId, request: input,
      } }))
      const recovered = await f.mcp.callTool({ name: 'agent_chat_send', arguments: {
        workspaceId: f.workspaceId, request: input,
      } })
      assert.notEqual(recovered.isError, true)
      const replay = SendAgentChatMessageResponseSchema.parse(decodeMcpToolResult(recovered))
      assert.equal(replay.replayed, true)
      assert.deepEqual(replay.turn, stored)
      const readback = await f.mcp.callTool({ name: 'agent_chat_read', arguments: {
        workspaceId: f.workspaceId, query: f.query,
      } })
      assert.notEqual(readback.isError, true)
      const state = AgentChatStateSchema.parse(decodeMcpToolResult(readback))
      assert.deepEqual(state.turns.filter(turn => turn.requestId === input.requestId), [stored])
      assert.equal(state.messages.filter(message => message.requestId === input.requestId).length, 1)
      assert.equal(f.native.prompts.length, 1, 'Recovery must not start another native turn.')
    } finally {
      admission.mockRestore()
      await pool.query('update management_principals set grants=$2::jsonb where id=$1',
        [writer.id, JSON.stringify(writer.grants)])
      await f.close()
    }
  })
})
