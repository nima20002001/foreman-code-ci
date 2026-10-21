import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { OperatorConversationState } from '@foreman-code/contracts'
import { OperatorConversationEvents } from '../src/modules/conversations/operatorChat.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { operator } from './fixtures/agent1OperatorChat.js'

describe('F18 Operator HTTP/SSE history boundary', () => {
  it('establishes two event connections with an oversized native result and exposes older history separately', async () => {
    const app = Fastify(), owner = operator()
    const snapshot: OperatorConversationState = {
      conversation: { id: 'chat', agentId: 'operator', scope: 'application', status: 'open' },
      messages: [], revision: 19, activeRequestId: null, turnState: 'idle',
      lastResult: { outcome: 'succeeded', output: { text: 'x'.repeat(9 * 1024 * 1024) } },
    }
    const cursors: unknown[] = []
    app.addHook('preHandler', async (request) => {
      request.operatorPrincipal = owner; request.reauthorizeOperator = async () => owner
    })
    registerOperatorChatRoutes(app, { events: new OperatorConversationEvents(), get: async () => snapshot,
      assertAccess: async () => ({}), history: async (_id: string, _owner: unknown, query: unknown) => {
        cursors.push(query)
        return { conversationId: 'chat', revision: 19, activeRequestId: null, nextCursor: null,
          entries: [{ sequence: '9007199254740993', message: { id: 'older', conversationId: 'chat', role: 'user', content: 'Older command' },
            receipt: { requestId: 'original-id', inputHash: 'a'.repeat(64), outcome: 'succeeded', retryable: false } }] }
      },
    } as never)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    try {
      for (let reconnect = 0; reconnect < 2; reconnect++) {
        const response = await fetch(`${address}/api/operator/conversations/chat/events`, { headers: { 'last-event-id': '9999' } })
        expect(response.status).toBe(200)
        const reader = response.body!.getReader()
        const frame = new TextDecoder().decode((await reader.read()).value)
        expect(frame).toContain('event: state')
        expect(frame).toContain('id: 19')
        expect(frame).toContain('"snapshotRequired":true')
        await reader.cancel()
      }
      const history = await app.inject('/api/operator/conversations/chat/history?before=9007199254740994&limit=1')
      expect(history.statusCode).toBe(200)
      expect(history.json().entries[0].receipt.requestId).toBe('original-id')
      expect(cursors).toEqual([{ before: '9007199254740994', limit: 1 }])
    } finally { await app.close() }
  })
})
