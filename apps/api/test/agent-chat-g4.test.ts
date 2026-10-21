import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import assert from 'node:assert/strict'
import type pg from 'pg'
import type { McpServer } from '@modelcontextprotocol/server'
import { describe, it, vi } from 'vitest'
import {
  AgentChatReadbackQuerySchema, AgentChatStateSchema, ReadAgentChatRequestSchema, ReadAgentChatResponseSchema,
  type AgentChatTurn,
} from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { agentChatTools } from '../src/mcp/operator/tools/agentChat.js'
import { registerOperatorToolGroup } from '../src/mcp/operator/server.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository, type AgentConversationRow } from '../src/modules/conversations/agentChatRepository.js'
import type { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'

const now = new Date('2026-09-27T00:00:00.000Z')
const principal: ManagementPrincipal = { id: 'g4-reader', name: 'G4 reader', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: ['workspace-g4'], workflowIds: ['workflow-g4'] } }] }
const context = { workspaceId: 'workspace-g4', workflowId: 'workflow-g4', workflowNodeId: 'node-g4', agentId: 'agent-g4' }
const { workspaceId, ...query } = context
function row(): AgentConversationRow {
  return { id: 'chat-g4', agent_key: 'g4', workspace_id: workspaceId, workflow_id: context.workflowId,
    workflow_node_id: context.workflowNodeId, agent_id: context.agentId, agent_configuration_version_id: 'config-g4',
    origin_run_id: null, origin_execution_id: null, harness: 'codex', provider_version: '0.154.0', native_session_id: 'native-g4',
    active_request_id: 'request-1', active_native_turn_id: 'native-turn-1', cancel_requested: true, turn_state: 'uncertain',
    last_error: null, revision: 1, pending_interaction: null, last_result: null,
    record: { origin: { kind: 'fresh' }, workingDirectory: '/tmp', runtimeDirectory: '/tmp/g4', startupDelivered: true },
    created_at: now, updated_at: now }
}
function receipt(index: number, delivery: AgentChatTurn['delivery'] = 'unknown') {
  return { request_id: `request-${index}`, turn_sequence: String(index), intent: 'next_turn', delivery,
    message_id: `message-${index}`, native_turn_id: null, target_native_turn_id: null, delivery_error: null,
    input_hash: 'unused', payload: { content: `message ${index}` }, created_at: now, updated_at: now }
}
type Sql = (sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
function poolFor(query: Sql, stateReads = false): pg.Pool {
  const execute = (text: string, values: readonly unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    if (stateReads && ['begin isolation level repeatable read read only', 'begin', 'commit', 'rollback'].includes(sql)) return Promise.resolve(result())
    if (stateReads && sql.includes('from management_command_receipts')) return Promise.resolve(result())
    if (stateReads && sql.includes('from file_tool_publications')) return Promise.resolve(result())
    if (stateReads && sql.startsWith('select conversation_id from operator_conversation_turns')) return Promise.resolve(result([{ conversation_id: 'chat-g4' }]))
    if (stateReads && sql.includes('from operator_conversation_activity')) return Promise.resolve(result())
    if (stateReads && sql.startsWith('select (select started_at from operator_conversation_turns')) return Promise.resolve(result([{ started_at: now, latest_request_id: values[1] ?? null }]))
    if (sql.startsWith('select id,name,audience,grants,expires_at,revoked_at,delegated_from from management_principals')) return Promise.resolve(result([
      { id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
        expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null },
    ]))
    return query(sql, values)
  }
  return { query: execute, connect: async () => ({ query: execute, release() {} }) } as unknown as pg.Pool
}
function result(rows: unknown[] = []) { return { rows, rowCount: rows.length } }
function service(pool: pg.Pool, repository = new PostgresAgentChatRepository(pool)) {
  return new AgentChatService(pool, repository, {} as PostgresOperatorConversationRepository,
    { getSavedVersion: async () => undefined, getCurrentSavedVersion: async () => undefined, getAgentConfiguration: async () => undefined },
    { getForWorkspace: async () => { throw new Error('G4 unit fixture must not read a Run.') }, getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, async *executionPages() { yield [] } },
    () => { throw new Error('G4 unit fixture must not create a native manager.') }, '/tmp/g4')
}

/** Scripted SQL unit fixtures, complemented by the opt-in PostgreSQL/authenticated transport suite. */
describe('G4 readback and legacy receipt recovery', () => {
  it('shares strict bigint pagination between MCP and HTTP without changing ordinary MCP read shape', () => {
    assert.deepEqual(ReadAgentChatRequestSchema.parse({ workspaceId, query }), { workspaceId, query })
    assert.deepEqual(ReadAgentChatRequestSchema.parse({ workspaceId, query, history: {}, receipts: { limit: 1 } }),
      { workspaceId, query, history: { limit: 50 }, receipts: { limit: 1 } })
    for (const before of ['0', '-1', '1.1', '9223372036854775808', 'x']) {
      assert.equal(AgentChatReadbackQuerySchema.safeParse({ before }).success, false)
    }
    assert.equal(AgentChatReadbackQuerySchema.parse({ before: '9223372036854775807' }).before, '9223372036854775807')
    for (const limit of [0, 101, 1.5]) assert.equal(AgentChatReadbackQuerySchema.safeParse({ limit }).success, false)
  })

  it('keeps strict overflow rejection, but the explicit recovery view always exposes a queued cleanup target', async () => {
    const stored = Array.from({ length: 103 }, (_, i) => receipt(i + 1))
    const queued = receipt(104, 'queued')
    const pool = poolFor(async (sql) => {
      if (sql.startsWith('select * from operator_conversations')) return result([row()])
      if (sql.startsWith('with open as')) return result(stored.slice(0, 101))
      if (sql.startsWith('select request_id') && sql.includes("delivery='queued'")) return result([queued])
      if (sql.startsWith('with candidates as')) return result([{ messages: [], has_earlier: false }])
      if (sql.includes('from operator_conversation_activity')) return result()
      throw new Error(`Unexpected SQL: ${sql}`)
    }, true)
    const repository = new PostgresAgentChatRepository(pool)
    const before = structuredClone(stored)
    await assert.rejects(repository.state('chat-g4'), { code: 'AGENT_CHAT_RECEIPT_OVERFLOW', status: 409 })
    const loaded = await repository.state('chat-g4', { recoverOverflow: true })
    assert.ok(loaded)
    assert.equal(loaded?.hasMoreTurns, true)
    assert.equal(loaded.turns.length, 100)
    assert.equal(loaded.turns.at(-1)?.requestId, 'request-104')
    assert.equal(loaded.turns.at(-1)?.delivery, 'queued')
    assert.deepEqual(stored, before, 'A read must not cancel or discard overflow receipts.')
    const state = await service(pool, repository)['state']({ context, row: row() }, principal)
    assert.equal(AgentChatStateSchema.safeParse(state).success, true)
    assert.equal(state.availability.canSend, false)
    assert.match(state.availability.message!, /recovery window/)
    assert.equal(state.activeTurn?.nativeTurnId, 'native-turn-1')
    assert.equal(state.capabilities.interruptAndSend, true)
  })

  it('does not flag normal state as overflow and retains every open receipt', async () => {
    const stored = Array.from({ length: 100 }, (_, i) => receipt(i + 1))
    const pool = poolFor(async (sql) => {
      if (sql.startsWith('select * from operator_conversations')) return result([row()])
      if (sql.startsWith('with open as')) return result(stored)
      if (sql.startsWith('with candidates as')) return result([{ messages: [], has_earlier: false }])
      throw new Error(`Unexpected SQL: ${sql}`)
    }, true)
    const loaded = await new PostgresAgentChatRepository(pool).state('chat-g4', { recoverOverflow: true })
    assert.equal(loaded?.hasMoreTurns, undefined)
    assert.deepEqual(loaded?.turns.map((entry) => entry.requestId), stored.map((entry) => entry.request_id))
  })

  it('pages all receipts with exact bigint cursors, ascending page order, and a null exhausted cursor', async () => {
    const base = 9007199254740993n
    const stored = Array.from({ length: 5 }, (_, i) => ({ ...receipt(i + 1), turn_sequence: String(base + BigInt(i)) }))
    const pool = poolFor(async (sql, values) => {
      assert.match(sql, /order by operator_conversation_turns.turn_sequence desc limit \(\$3::integer\+1\)/)
      assert.equal(values[0], 'chat-g4')
      const before = values[1] as string | null
      return result(stored.filter((entry) => before === null || BigInt(entry.turn_sequence) < BigInt(before))
        .slice().reverse().slice(0, Number(values[2]) + 1))
    }, true)
    const repository = new PostgresAgentChatRepository(pool)
    const newest = await repository.receipts('chat-g4', undefined, 2)
    assert.deepEqual(newest.turns.map((entry) => entry.requestId), ['request-4', 'request-5'])
    assert.equal(newest.nextCursor, String(base + 3n))
    const middle = await repository.receipts('chat-g4', newest.nextCursor!, 2)
    const oldest = await repository.receipts('chat-g4', middle.nextCursor!, 2)
    assert.equal(oldest.nextCursor, null)
    assert.deepEqual([...oldest.turns, ...middle.turns, ...newest.turns].map((entry) => entry.requestId), stored.map((entry) => entry.request_id))
  })

  it('A2-PF-09: MCP read can request complete oversized history and receipt pages through the same authorized services', async () => {
    const pool = poolFor(async (sql) => {
      if (sql.startsWith('select * from operator_conversations')) return result([row()])
      if (sql.startsWith('with open as')) return result([receipt(1)])
      if (sql.startsWith('with candidates as')) return result([{ messages: [], has_earlier: true }])
      if (sql.includes('from operator_conversation_activity')) return result()
      throw new Error(`Unexpected SQL: ${sql}`)
    }, true)
    const chat = service(pool)
    const state = await chat['state']({ context, row: row() }, principal)
    const message = { id: 'large-g4', conversationId: 'chat-g4', role: 'assistant' as const, requestId: 'request-1',
      content: '界'.repeat(150_000), createdAt: now.toISOString(), updatedAt: now.toISOString() }
    const history = { conversationId: 'chat-g4', messages: [message], nextCursor: '2' }
    const receipts = { conversationId: 'chat-g4', turns: state.turns, nextCursor: null }
    const read = vi.spyOn(chat, 'read').mockResolvedValue(state)
    const page = vi.spyOn(chat, 'history').mockResolvedValue(history)
    const turns = vi.spyOn(chat, 'receipts').mockResolvedValue(receipts)
    const register = vi.fn()
    const operator = { principal, services: { agentChat: chat } } as unknown as OperatorRequestContext
    registerOperatorToolGroup({ registerTool: register } as unknown as McpServer, operator, agentChatTools)
    const [name, options, handle] = register.mock.calls.find(([name]) => name === 'agent_chat_read')!
    assert.equal(name, 'agent_chat_read')
    assert.match(options.description, /history.nextCursor/)
    assert.equal(options.annotations.readOnlyHint, true)
    const input = ReadAgentChatRequestSchema.parse({ workspaceId, query, history: { limit: 1, before: '3' }, receipts: { limit: 100 } })
    const response = await handle(input)
    const output = ReadAgentChatResponseSchema.parse(decodeMcpToolResult(response))
    assert.deepEqual(output.history, history)
    assert.deepEqual(output.receipts, receipts)
    assert.equal(page.mock.calls[0]![2], 'chat-g4')
    assert.deepEqual(page.mock.calls[0]!.slice(3), ['3', 1])
    assert.deepEqual(turns.mock.calls[0]!.slice(3), [undefined, 100])
    const ordinary = await handle({ workspaceId, query })
    assert.deepEqual(decodeMcpToolResult(ordinary), state)
    assert.equal(page.mock.calls.length, 1)
    assert.equal(read.mock.calls.length, 2)
  })

  it('denies both readback services before fetching pages for a mismatched workflow scope', async () => {
    const pool = poolFor(async (sql) => {
      assert.match(sql, /^select \* from operator_conversations/)
      return result([row()]) // Any history/receipt SQL in this test is a failure.
    })
    const chat = service(pool)
    const denied = { ...principal, grants: [{ actions: ['agent_chat:read' as const], scope: { workflowIds: ['other-workflow'] } }] }
    await assert.rejects(chat.history(denied, workspaceId, 'chat-g4', undefined, 50), { status: 403 })
    await assert.rejects(chat.receipts(denied, workspaceId, 'chat-g4', undefined, 50), { status: 403 })
  })
})

describe('G4 unknown activity and App environment classification', () => {
  it('T-09: abandonment settles only unfinished activity to unknown, preserving native/cancel/approval ownership', async () => {
    const owner = row()
    const activities = ['pending', 'running', 'completed', 'failed', 'canceled', 'unknown'].map((status) => ({ status, revision: 1 }))
    let delivery = 'accepted'
    let conversationLocked = false
    const pool = poolFor(async (sql, values) => {
      if (['begin', 'commit', 'rollback'].includes(sql)) return result()
      if (sql.startsWith('select id from operator_conversations') && sql.endsWith('for update')) {
        conversationLocked = true; return result([{ id: 'chat-g4' }])
      }
      if (sql.startsWith('update operator_conversation_turns')) {
        assert.equal(conversationLocked, true, 'Conversation lock must precede the receipt update.')
        delivery = 'unknown'; return result()
      }
      if (sql.startsWith('update operator_conversations')) {
        assert.ok(!sql.includes('active_request_id=null') && !sql.includes('pending_interaction=null') && !sql.includes('cancel_requested=false'))
        owner.turn_state = 'uncertain'; owner.revision = Number(owner.revision) + 1
        return result()
      }
      if (sql.startsWith('update operator_conversation_activity')) {
        assert.deepEqual(values, ['chat-g4', 'request-1'])
        assert.match(sql, /record->>'status' in \('pending','running'\)/)
        assert.match(sql, /and exists \(select 1 from operator_conversation_turns/)
        assert.match(sql, /delivery='unknown'/)
        for (const activity of activities) if (delivery === 'unknown' && ['pending', 'running'].includes(activity.status)) {
          activity.status = 'unknown'; activity.revision++
        }
        return result()
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    })
    const repository = new PostgresAgentChatRepository(pool)
    const ownership = () => ({ requestId: owner.active_request_id, nativeTurnId: owner.active_native_turn_id,
      cancelRequested: owner.cancel_requested, pending: owner.pending_interaction })
    const before = structuredClone(ownership())
    await repository.abandon('chat-g4', 'request-1', 'Exact native evidence is not available.')
    assert.deepEqual(activities.map((entry) => entry.status), ['unknown', 'unknown', 'completed', 'failed', 'canceled', 'unknown'])
    assert.deepEqual(activities.map((entry) => entry.revision), [2, 2, 1, 1, 1, 1])
    await repository.abandon('chat-g4', 'request-1', 'Still unconfirmed.')
    assert.deepEqual(activities.map((entry) => entry.revision), [2, 2, 1, 1, 1, 1])
    assert.deepEqual(ownership(), before)
  })

  it('T-09: an activity write failure rolls back abandonment; the SQL guards terminal receipts', async () => {
    const calls: string[] = []
    const pool = poolFor(async (sql) => {
      calls.push(sql)
      if (sql.startsWith('update operator_conversation_activity')) throw new Error('activity write failed')
      return result()
    })
    await assert.rejects(new PostgresAgentChatRepository(pool).abandon('chat-g4', 'request-1', 'unconfirmed'), /activity write failed/)
    assert.equal(calls.at(-1), 'rollback')
    assert.ok(!calls.includes('commit'))
    assert.match(calls.find((sql) => sql.startsWith('update operator_conversation_activity'))!, /delivery='unknown'/)
  })

  for (const code of ['CODEX_MCP_CONFIG_INVALID', 'CODEX_ENVIRONMENT_INVALID']) {
    it(`A-R01 classification: ${code} is harness unavailable, not a missing native session`, async () => {
      const captured: unknown[][] = []
      const pool = poolFor(async (sql, values) => {
        assert.match(sql, /^update operator_conversations set record=record/)
        captured.push([...values]); return result()
      })
      const chat = service(pool)
      for (const error of [{ code }, { result: { outcome: 'failed', error: { code, message: 'validation failed', retryable: false } } }]) {
        assert.equal(await chat['markNativeUnavailable']('chat-g4', error), true)
      }
      assert.deepEqual(captured.map((values) => values[2]), ['harness_unavailable', 'harness_unavailable'])
      assert.ok(captured.every((values) => String(values[1]).includes('does not match the accepted conversation scope')))
    })
  }

  it('does not classify an arbitrary transport timeout or absent optional MCP entry as permanent unavailability', async () => {
    const chat = service(poolFor(async () => { throw new Error('No permanent state may be written.') }))
    for (const error of [new Error('transport timeout'), { code: 'CODEX_MCP_INSPECTION_FAILED' }, { code: 'CODEX_MCP_NOT_CONFIGURED' }, { code: 'CLAUDE_NATIVE_DELIVERY_UNCERTAIN' }]) {
      assert.equal(await chat['markNativeUnavailable']('chat-g4', error), false)
    }
  })
})
