import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, vi } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { runChatStorageKey } from '../src/modules/conversations/selectedRunChat.js'
import { eventually } from './helpers/agentChatF5.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { waitForSuccessfulRunCleanup } from './helpers/runSettlement.testSupport.js'

/** Real PostgreSQL admission, live delegation reader and authenticated transports.
 * No native provider should be reached by any of these rejected commands. */
async function setup() {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential'), approvalNodeIds: [] })
  const repository = new PostgresAgentChatRepository(f.db.pool)
  const managers = vi.fn(() => { throw new Error('A revoked admission must not create native work') })
  const chat = new AgentChatService(f.db.pool, repository, new PostgresOperatorConversationRepository(f.db.pool),
    f.workflows, f.runs, managers, f.db.directory)
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: { ...f.services, agentChat: chat } } })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    await f.engine.start(f.f.run.id)
    await waitForSuccessfulRunCleanup({ pool: f.db.pool, runId: f.f.run.id, timeoutMs: 20000,
      readRecord: () => f.services.runs.inspection.record(f.writer.principal, { workspaceId: f.f.scope.workspaceId, runId: f.f.run.id }) })
    const executions: HarnessExecution[] = []
    for await (const page of f.runs.executionPages(f.f.run.id)) executions.push(...page)
    const node = f.f.version.definition.nodes[0]!
    const execution = executions.find((entry) => entry.workflowNodeId === node.id)!
    expect(execution.state).toBe('completed')
    expect(execution.nativeSessionId).toBeTruthy()
    expect(execution.workingDirectory).toBeTruthy()
    const context: AgentChatContext = { workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId,
      runId: f.f.run.id, workflowNodeId: node.id, agentId: node.agentId }
    return { f, repository, managers, chat, app, context, execution,
      async connect(token: string) {
        const client = new Client({ name: 'rh01-admission', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      },
      async close() {
        await chat.shutdown(); await Promise.allSettled(clients.map((client) => client.close())); await app.close(); await f.close()
      } }
  } catch (error) { await chat.shutdown(); await app.close(); await f.close(); throw error }
}

async function chatRows(pool: pg.Pool) {
  return {
    conversations: (await pool.query("select * from operator_conversations where kind='agent' order by id")).rows,
    messages: (await pool.query(`select m.* from operator_conversation_messages m
      join operator_conversations c on c.id=m.conversation_id where c.kind='agent' order by m.id`)).rows,
    receipts: (await pool.query(`select t.* from operator_conversation_turns t
      join operator_conversations c on c.id=t.conversation_id where c.kind='agent' order by t.conversation_id,t.request_id`)).rows,
  }
}

export type RevocationCase = {
  transport: 'http' | 'mcp'
  revocation: 'principal' | 'parent'
  boundary: 'first-advisory' | 'existing-advisory' | 'existing-row'
}

export async function assertRevocationRejected({ transport, revocation, boundary }: RevocationCase) {
  const test = await setup(), { f, context, execution } = test
  let blocker: pg.PoolClient | undefined
  let revoker: pg.PoolClient | undefined
  let pending: Promise<void> | undefined
  try {
    const grants: ManagementGrant[] = [{ actions: ['agent_chat:read', 'agent_chat:write'],
      scope: { workspaceIds: [context.workspaceId], workflowIds: [context.workflowId], runIds: [execution.runId] } }]
    const parent = await f.access.issue({ name: 'RH-01 parent', audience: 'operator', grants, expiresAt: new Date(Date.now() + 600000) })
    const sender = await f.access.issue({ name: 'RH-01 sender', audience: 'operator', grants, expiresAt: new Date(Date.now() + 600000) })
    // Persist a real delegation, not a principal/grant reader mock.
    await f.db.pool.query('update management_principals set delegated_from=$2 where id=$1', [sender.principal.id, parent.principal.id])
    const mcp = transport === 'mcp' ? await test.connect(sender.token) : undefined
    const key = runChatStorageKey(context, execution.id)
    const { workspaceId, ...requestContext } = context
    let expectedConversationId: string | null = null
    if (boundary !== 'first-advisory') {
      const seeded = await test.repository.admit({ key, context, delivery: 'queued',
        request: { context: requestContext, requestId: 'retained-message', content: 'Retained transcript.',
          intent: 'next_turn', expectedConversationId: null },
        create: { context, agentConfigurationVersionId: execution.agentConfigurationVersionId, harness: 'codex',
          origin: { kind: 'run_execution', runId: execution.runId, executionId: execution.id, sourceNativeSessionId: execution.nativeSessionId! },
          workingDirectory: execution.workingDirectory!, runtimeDirectory: '' } })
      expectedConversationId = seeded.conversationId
      await test.repository.cancelQueued(seeded.conversationId, seeded.turn.requestId)
    }
    const before = await chatRows(f.db.pool)
    const published = vi.spyOn(test.chat.events, 'publish')
    blocker = await f.db.pool.connect()
    await blocker.query('begin')
    const blockerPid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    if (boundary === 'existing-row') {
      await blocker.query('select id from operator_conversations where id=$1 for update', [expectedConversationId])
    } else {
      await blocker.query('select pg_advisory_xact_lock(hashtext($1))', [`agent-chat:${key}`])
    }
    const message = { requestId: randomUUID(), content: 'Must not be admitted after revocation.', intent: 'next_turn' as const, expectedConversationId }
    const selection = { workflowId: context.workflowId, runId: execution.runId, workflowNodeId: context.workflowNodeId, executionId: execution.id }
    // Attach the continuation immediately: Fastify inject's thenable must actually start.
    pending = transport === 'http'
      ? test.app.inject({ method: 'POST',
        url: `/api/workspaces/${workspaceId}/agent-chat/workflows/${context.workflowId}/runs/${execution.runId}/nodes/${context.workflowNodeId}/messages`,
        headers: { authorization: `Bearer ${sender.token}` }, payload: { executionId: execution.id, ...message },
      }).then((response) => {
        expect(response.statusCode, response.body).toBe(403)
        expect(response.json()).toMatchObject({ error: { code: 'AUTH_REVOKED' } })
      })
      : mcp!.callTool({ name: 'agent_chat_send', arguments: { workspaceId, selection, message } }).then((response) => {
        expect(response.isError, JSON.stringify(response)).toBe(true)
        expect(response.structuredContent).toBeUndefined()
        expect(JSON.stringify(response)).toMatch(/AUTH_REVOKED|no longer active/)
      })
    void pending.catch(() => undefined)
    // Observe an actual blocked SQL statement, not a sleep or a pre-authentication barrier.
    await eventually(async () => {
      const waiting = await f.db.pool.query<{ query: string }>(`select query from pg_stat_activity
        where datname=current_database() and $1::int=any(pg_blocking_pids(pid)) and wait_event_type='Lock'`, [blockerPid])
      return waiting.rows.some((row) => boundary === 'existing-row'
        ? row.query.includes('operator_conversations') && row.query.includes('for update')
        : row.query.includes('pg_advisory_xact_lock'))
    })
    revoker = await f.db.pool.connect()
    await revoker.query('begin')
    // A fix that holds authority before the admission wait must fail rather than hang.
    await revoker.query("set local lock_timeout='3s'")
    const revokedId = revocation === 'parent' ? parent.principal.id : sender.principal.id
    expect((await revoker.query('update management_principals set revoked_at=now() where id=$1', [revokedId])).rowCount).toBe(1)
    await revoker.query('commit')
    revoker.release(); revoker = undefined
    expect((await f.db.pool.query<{ revoked_at: Date | null }>('select revoked_at from management_principals where id=$1', [revokedId])).rows[0]!.revoked_at).not.toBeNull()
    await blocker.query('commit')
    blocker.release(); blocker = undefined
    await pending
    expect(await chatRows(f.db.pool)).toEqual(before)
    expect(test.managers).not.toHaveBeenCalled()
    expect(published).not.toHaveBeenCalled()
    expect(f.dispatchErrors).toEqual([])
  } finally {
    if (revoker) { await revoker.query('rollback').catch(() => undefined); revoker.release() }
    if (blocker) { await blocker.query('rollback').catch(() => undefined); blocker.release() }
    await pending?.catch(() => undefined)
    await test.close()
  }
}
