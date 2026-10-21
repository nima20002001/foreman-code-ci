import type pg from 'pg'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'

const owner: ManagementPrincipal = { id: 'summary-owner', name: 'Owner', audience: 'operator',
  grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null }
function fixture() {
  const query = vi.fn().mockResolvedValue({ rows: [{
    id: 'owned-chat', title: 'Owned chat', turn_state: 'active', revision: '7',
    active_request_id: 'request', needs_attention: true,
    messages: [{ content: 'Private history' }], pending_interaction: { payload: 'Private native request' },
  }] })
  const repository = new PostgresOperatorConversationRepository({ query } as unknown as pg.Pool)
  // Unused native dependencies are intentionally not invoked by a read-only summary.
  const chat = new OperatorChatService(repository, undefined as never, undefined as never, '/unused', undefined as never)
  return { query, chat }
}
describe('owner-scoped lightweight navigation', () => {
  it('returns a bounded status projection without histories or native payloads', async () => {
    const { query, chat } = fixture()
    const result = await chat.summaries(owner)
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]![1]).toEqual([owner.id, null, false])
    expect(result).toEqual([{ conversationId: 'owned-chat', title: 'Owned chat', turnState: 'active', revision: 7, activeRequestId: 'request', needsAttention: true }])
  })
  it('reports persisted unresolved background work independently of the message/activity page', async () => {
    const { query, chat } = fixture()
    query.mockResolvedValue({ rows: [{ id: 'owned-chat', title: 'Owned chat', turn_state: 'idle', revision: '8', active_request_id: null,
      needs_attention: false, background_activity: 'unknown' }] })
    expect(await chat.summaries(owner)).toMatchObject([{ backgroundActivity: 'unknown', activeRequestId: null, turnState: 'idle' }])
  })
  it('bounds the database projection and reports whether more chats exist', async () => {
    const { chat, query } = fixture()
    query.mockResolvedValue({ rows: ['first', 'second'].map((id) => ({ id, title: id, turn_state: 'idle', revision: '1', active_request_id: null, needs_attention: false })) })
    const app = Fastify()
    app.addHook('preHandler', async (request) => { request.operatorPrincipal = owner })
    registerOperatorChatRoutes(app, chat)
    try {
      const response = await app.inject({ method: 'GET', url: '/api/operator/conversations/summaries?limit=1' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ hasMore: true, conversations: [{ conversationId: 'first' }] })
      expect(response.json().conversations).toHaveLength(1)
      expect(query.mock.calls[0]![1]).toEqual([owner.id, 2, false])
    } finally { await app.close() }
  })
  it('checks permission before touching the database', () => {
    const { query, chat } = fixture()
    expect(() => chat.summaries({ ...owner, grants: [] })).toThrow()
    expect(query).not.toHaveBeenCalled()
  })
  it('routes summaries before the dynamic conversation route and applies the response contract', async () => {
    const { chat } = fixture()
    const app = Fastify()
    app.addHook('preHandler', async (request) => { request.operatorPrincipal = owner })
    registerOperatorChatRoutes(app, chat)
    try {
      const response = await app.inject({ method: 'GET', url: '/api/operator/conversations/summaries' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ conversations: [{ conversationId: 'owned-chat', title: 'Owned chat', turnState: 'active', revision: 7, activeRequestId: 'request', needsAttention: true }] })
    } finally { await app.close() }
  })
})
