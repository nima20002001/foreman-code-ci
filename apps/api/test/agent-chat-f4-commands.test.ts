import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { AgentChatCommands } from '../src/modules/conversations/agentChatCommands.js'
import { DomainError } from '../src/modules/errors.js'

const principal: ManagementPrincipal = { id: 'f4-principal', name: 'F4', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['agent_chat:read', 'agent_chat:cancel', 'agent_chat:respond'], scope: {} }] }

/** SQL substitute for unit fault injection only, not PostgreSQL/native proof. */
function store() {
  const receipts = new Map<string, { target_key: unknown; input_hash: unknown; result: unknown }>()
  let failSettlement = false
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    const key = JSON.stringify(values.slice(0, 3))
    if (sql.includes('with claimed as')) {
      if (receipts.has(key)) return { rowCount: 0, rows: [] }
      receipts.set(key, { target_key: values[3], input_hash: values[4], result: JSON.parse(String(values[6] ?? '{"status":"pending"}')) })
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes('with settled as')) {
      if (failSettlement) throw new Error('connection lost after native effect')
      receipts.get(key)!.result = JSON.parse(String(values[3]))
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes('select target_key,input_hash,result')) return { rows: [receipts.get(key)], rowCount: 1 }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  return { pool: { query } as unknown as pg.Pool, receipts, query, failSettlement: () => { failSettlement = true } }
}

describe('F4 A-R12 durable control identity', () => {
  for (const kind of ['interrupt', 'cancel_queued', 'respond']) {
    it(`${kind}: lost-response HTTP-to-MCP replay returns the original state without touching later work`, async () => {
      const memory = store()
      const input = { kind, workspaceId: 'workspace', nativeRequestId: 'approval-one', optionId: 'approve' }
      let state = structuredClone(agentChatFixtures.idleAfterCompletion)
      const perform = vi.fn(async () => state)
      const original = await new AgentChatCommands(memory.pool).execute(principal, 'http', 'conversation', 'control-1', input, perform)
      state = { ...state, revision: state.revision + 10 }
      // A new coordinator represents process restart, not an in-memory response cache.
      const replay = await new AgentChatCommands(memory.pool).execute(principal, 'mcp', 'conversation', 'control-1', input, perform)
      expect(replay).toEqual(original)
      expect(replay.revision).not.toBe(state.revision)
      expect(perform).toHaveBeenCalledTimes(1)
      expect(memory.receipts.size).toBe(1)
      await expect(new AgentChatCommands(memory.pool).execute(principal, 'mcp', 'conversation', 'control-1',
        { ...input, optionId: 'reject' }, perform)).rejects.toMatchObject({ code: 'AGENT_CHAT_REQUEST_CONFLICT', status: 409 })
      await expect(new AgentChatCommands(memory.pool).execute(principal, 'http', 'other-conversation', 'control-1',
        input, perform)).rejects.toMatchObject({ code: 'AGENT_CHAT_REQUEST_CONFLICT' })
      expect(perform).toHaveBeenCalledTimes(1)
    })
  }

  it('returns authorized current readback on HTTP/MCP receipt replay without lowering revisions or repeating effects', async () => {
    const memory = store(), commands = new AgentChatCommands(memory.pool)
    let state = structuredClone(agentChatFixtures.idleAfterCompletion)
    const perform = vi.fn(async () => state)
    const readCurrent = vi.fn(async () => state)
    await commands.execute(principal, 'http', 'c', 'r', { kind: 'interrupt' }, perform, readCurrent)
    const receipt = structuredClone([...memory.receipts.values()][0]!.result)
    state = { ...state, revision: state.revision + 10 }
    const replay = await new AgentChatCommands(memory.pool).execute(principal, 'mcp', 'c', 'r',
      { kind: 'interrupt' }, perform, readCurrent)
    expect(replay.revision).toBe(state.revision)
    expect([...memory.receipts.values()][0]!.result).toEqual(receipt)
    expect(perform).toHaveBeenCalledTimes(1)
    const denied = vi.fn(async () => { throw new DomainError('ACCESS_DENIED', 'Revoked.', 403) })
    await expect(commands.execute(principal, 'mcp', 'c', 'r', { kind: 'interrupt' }, perform, denied))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(perform).toHaveBeenCalledTimes(1)
  })

  it('records the validated answer before native I/O and preserves its exact source through uncertain HTTP/MCP replay', async () => {
    const memory = store(), commands = new AgentChatCommands(memory.pool)
    const metadata = { schemaVersion: 1 as const, kind: 'respond' as const, conversationId: 'c', modelRequestId: 'model-A',
      scope: { kind: 'agent_chat' as const, conversationId: 'c', workspaceId: 'w', workflowId: 'f', nodeId: 'n', agentId: 'a' },
      native: { harness: 'codex', sessionId: 'native-session', turnId: 'native-turn', requestId: 'native-ask', requestType: 'approval' },
      choice: { optionId: 'opaque-option', semantic: 'approve_once' } }
    const perform = vi.fn(async () => {
      expect([...memory.receipts.values()][0]!.result).toEqual({ status: 'pending', acceptedControl: metadata })
      throw new Error('Provider response accepted; transport acknowledgment lost.')
    })
    const request = { kind: 'respond', nativeRequestId: 'native-ask', optionId: 'opaque-option' }
    await expect(commands.execute(principal, 'http', 'c', 'control-answer', request, perform, undefined, metadata))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_CONTROL_UNCONFIRMED' })
    await expect(new AgentChatCommands(memory.pool).execute(principal, 'mcp', 'c', 'control-answer', request, perform))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_CONTROL_UNCONFIRMED' })
    expect([...memory.receipts.values()][0]!.result).toEqual({ status: 'uncertain', acceptedControl: metadata })
    expect(perform).toHaveBeenCalledTimes(1)
  })

  it('fences an overlapping retry and a changed control kind while the first control is in flight', async () => {
    const memory = store(), commands = new AgentChatCommands(memory.pool)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const perform = vi.fn(async () => { entered(); await gate; return agentChatFixtures.idleAfterCompletion })
    const first = commands.execute(principal, 'http', 'c', 'r', { kind: 'interrupt' }, perform)
    await started
    try {
      await expect(commands.execute(principal, 'mcp', 'c', 'r', { kind: 'interrupt' }, perform))
        .rejects.toMatchObject({ code: 'AGENT_CHAT_CONTROL_UNCONFIRMED' })
      await expect(commands.execute(principal, 'mcp', 'c', 'r', { kind: 'respond' }, perform))
        .rejects.toMatchObject({ code: 'AGENT_CHAT_REQUEST_CONFLICT' })
      expect(perform).toHaveBeenCalledTimes(1)
    } finally { release(); await first }
  })

  it('does not redeliver a response after an ambiguous provider or outcome-persistence failure', async () => {
    for (const fault of ['provider', 'persistence']) {
      const memory = store()
      if (fault === 'persistence') memory.failSettlement()
      const perform = vi.fn(async () => {
        if (fault === 'provider') throw new Error('response accepted, acknowledgement lost')
        return agentChatFixtures.idleAfterCompletion
      })
      const execute = () => new AgentChatCommands(memory.pool).execute(principal, 'http', 'c', 'r', { kind: 'respond', optionId: 'yes' }, perform)
      await expect(execute()).rejects.toMatchObject({ code: 'AGENT_CHAT_CONTROL_UNCONFIRMED' })
      await expect(execute()).rejects.toMatchObject({ code: 'AGENT_CHAT_CONTROL_UNCONFIRMED' })
      expect(perform).toHaveBeenCalledTimes(1)
    }
  })

  it('replays a definite validation rejection and conflicts on a changed target', async () => {
    const memory = store(), commands = new AgentChatCommands(memory.pool)
    const perform = vi.fn(async () => { throw new DomainError('AGENT_CHAT_TURN_STARTED', 'Already started.', 409) })
    for (const source of ['http', 'mcp'] as const) {
      await expect(commands.execute(principal, source, 'c', 'r', { kind: 'cancel_queued', turnRequestId: 'old' }, perform))
        .rejects.toMatchObject({ code: 'AGENT_CHAT_TURN_STARTED' })
    }
    await expect(commands.execute(principal, 'mcp', 'c', 'r', { kind: 'cancel_queued', turnRequestId: 'new' }, perform))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_REQUEST_CONFLICT' })
    expect(perform).toHaveBeenCalledTimes(1)
  })

  it('drains the durable control outcome before shutdown and admits no later commands', async () => {
    const memory = store(), commands = new AgentChatCommands(memory.pool)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const perform = vi.fn(async () => { entered(); await gate; return agentChatFixtures.idleAfterCompletion })
    const command = commands.execute(principal, 'http', 'c', 'r', { kind: 'respond' }, perform)
    await started
    let drained = false
    const drain = commands.drain().then(() => { drained = true })
    try {
      await expect(commands.execute(principal, 'mcp', 'c', 'later', { kind: 'interrupt' }, perform))
        .rejects.toMatchObject({ code: 'AGENT_CHAT_CLOSING' })
      expect(drained).toBe(false)
      expect(perform).toHaveBeenCalledTimes(1)
    } finally { release(); await command; await drain }
    expect([...memory.receipts.values()][0]!.result).toMatchObject({ status: 'completed' })
    expect(drained).toBe(true)
  })

})
