import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allExecutions, conversationPages, historicalFixture, historicalRows, openHistoricalApi,
  readSelected, runA, selectedPath, sendAndFinish, type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { chatTarget, rejectedSend, retainedChatRows } from './helpers/historicalRunChat.js'

afterEach(() => vi.restoreAllMocks())

// PostgreSQL and the authenticated transports/services are real. Native providers
// are existing deterministic port fixtures. No additional product/migration mocks
// are introduced; inherited location/native qualification substitutes stay explicit.
describe.skipIf(!postgresEnabled)('Historical Run-scoped chat recovery PostgreSQL / HTTP / MCP', () => {
  it('reopens the isolated historical database with scoped HTTP and MCP authentication', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      const execution = (await allExecutions(f))[0]!
      api = await openHistoricalApi(f)
      const target = chatTarget(api, execution)
      const before = await readSelected(api, target, execution.id)
      expect(before).toMatchObject({ kind: 'selected', state: { availability: { canSend: true } } })
      await api.close()
      api = await openHistoricalApi(f)
      expect(await readSelected(api, target, execution.id)).toEqual(before)

      const denied = await api.access.issue({
        name: 'Unrelated workspace reader',
        audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: ['unrelated-workspace'] } }],
      })
      const deniedClient = await api.connect(denied.token)
      const http = await api.app.inject({
        method: 'GET',
        url: selectedPath(target),
        headers: { authorization: `Bearer ${denied.token}` },
      })
      expect(http.statusCode, http.body).toBe(403)
      expect(http.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const { workspaceId, ...selection } = target
      const mcp = await deniedClient.callTool({
        name: 'agent_chat_read',
        arguments: { workspaceId, selection: { ...selection, executionId: execution.id } },
      })
      expect(mcp.isError, JSON.stringify(mcp)).toBe(true)
      expect(mcp.structuredContent).toBeUndefined()
      expect(JSON.stringify(mcp)).toContain('ACCESS_DENIED')
      expect(api.native.size).toBe(0)
      expect(f.dispatchErrors).toEqual([])
    } finally {
      try { await api?.close() } finally { await f.close() }
    }
  }, 120_000)

  it.each(['missing-child', 'missing-provider'] as const)(
    '[SCH-12-C03] %s after restart stays unavailable with readable transcript/receipts and no replacement', async (kind) => {
      const f = await historicalFixture()
      let api: HistoricalApi | undefined
      try {
        await runA(f)
        const y = f.f.version.definition.nodes[1]!
        const execution = (await allExecutions(f)).find((entry) => entry.workflowNodeId === y.id)!
        api = await openHistoricalApi(f)
        const target = chatTarget(api, execution)
        const { id } = await sendAndFinish(api, target, execution.id, null, 'before-runtime-loss', `Retained ${kind} transcript.`)
        expect(await readSelected(api, target, execution.id)).toMatchObject({ kind: 'selected', state: { availability: { canSend: true } } })
        const pagesBefore = await conversationPages(api, target, execution.id)
        const before = await historicalRows(f.db.pool, [f.f.run.id])
        await api.close()
        // Simulate loss of chat-owned identity only. No Run/source session,
        // immutable configuration, result or snapshot row is rewritten.
        if (kind === 'missing-child') await f.db.pool.query('update operator_conversations set native_session_id=null where id=$1', [id])
        if (kind === 'missing-provider') await f.db.pool.query('update operator_conversations set provider_version=null where id=$1', [id])
        api = await openHistoricalApi(f)
        const unavailable = await readSelected(api, target, execution.id)
        expect(unavailable).toMatchObject({ kind: 'selected', key: pagesBefore.key,
          state: { sessionState: 'unavailable', availability: { canSend: false, reason: 'native_session_missing' },
            capabilities: { resume: false, queueNextTurn: false, interruptAndSend: false, steer: 'unavailable' } } })
        if (unavailable.kind !== 'selected') throw new Error('Retained chat must remain readable')
        expect(unavailable.state.availability.message).toEqual(expect.any(String))
        expect(unavailable.state.availability.message?.length ?? 0).toBeGreaterThan(0)
        const readable = await conversationPages(api, target, execution.id)
        expect(readable.history).toEqual(pagesBefore.history)
        expect(readable.receipts).toEqual(pagesBefore.receipts)
        expect(readable.history!.messages.some((message) => message.content === `Retained ${kind} transcript.`)).toBe(true)
        const conversationsBefore = await retainedChatRows(api)
        await rejectedSend(api, target, execution.id, id, 'AGENT_CHAT_UNAVAILABLE')
        expect(await retainedChatRows(api)).toEqual(conversationsBefore)
        const afterDenial = await conversationPages(api, target, execution.id)
        expect(afterDenial.history).toEqual(pagesBefore.history)
        expect(afterDenial.receipts).toEqual(pagesBefore.receipts)
        expect(api.native.size).toBe(0)
        expect(await historicalRows(f.db.pool, [f.f.run.id])).toEqual(before)
        expect(f.dispatchErrors).toEqual([])
      } finally { try { await api?.close() } finally { await f.close() } }
    }, 120_000)
})
