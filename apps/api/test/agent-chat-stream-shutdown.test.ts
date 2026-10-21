import Fastify, { type FastifyError } from 'fastify'
import { expect, it, vi } from 'vitest'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { AgentChatEvents, type AgentChatService } from '../src/modules/conversations/agentChat.js'
import { DomainError } from '../src/modules/errors.js'
import { registerAgentChatRoutes } from '../src/routes/agentChat.js'
import { deferred } from './helpers/deferred.js'

const principal: ManagementPrincipal = { id: 'stream-reader', name: 'Stream reader', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: ['agent_chat:read'], scope: {} }] }

for (const stage of ['authentication', 'snapshot', 'established'] as const) {
  it(`drains chat streams during shutdown with a request in ${stage}`, async () => {
    const entered = deferred(), release = deferred(), swept = deferred()
    const app = Fastify()
    app.decorateRequest('operatorPrincipal', null, [])
    app.decorateRequest('reauthorizeOperator', null, [])
    app.setErrorHandler<FastifyError>((error, _request, reply) => {
      reply.code(error instanceof DomainError ? error.status : 500).send({ code: error.code })
    })
    app.addHook('preHandler', async request => {
      if (stage === 'authentication') { entered.resolve(); await release.promise }
      request.operatorPrincipal = principal
      request.reauthorizeOperator = async () => principal
    })
    const chat = { events: new AgentChatEvents(), assertReadable: vi.fn(async () => undefined),
      readConversation: vi.fn(async () => {
        if (stage === 'snapshot') { entered.resolve(); await release.promise }
        return agentChatFixtures.active
      }) }
    registerAgentChatRoutes(app, chat as unknown as AgentChatService)
    app.addHook('preClose', async () => { swept.resolve() })
    const released = vi.fn()
    app.addHook('onClose', async () => { released() })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const abort = new AbortController()
    const context = agentChatFixtures.active
    const response = fetch(`${address}/api/workspaces/${context.context.workspaceId}/agent-chat/conversations/${context.conversation.id}/events`,
      { signal: abort.signal })
    let closing: Promise<void> | undefined
    try {
      if (stage === 'established') {
        const stream = await response
        expect(stream.status).toBe(200)
        const reader = stream.body!.getReader()
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot')
        closing = app.close()
        expect((await reader.read()).done).toBe(true)
      } else {
        await entered.promise
        closing = app.close()
        await swept.promise
        expect(released).not.toHaveBeenCalled()
        release.resolve()
        const result = await response
        expect(result.status).toBe(503)
        expect(result.headers.get('content-type')).not.toContain('text/event-stream')
        await result.text()
      }
      await closing
      expect(released).toHaveBeenCalledOnce()
      if (stage === 'authentication') expect(chat.readConversation).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      abort.abort()
      await response.catch(error => { if (!abort.signal.aborted) throw error })
      await (closing ?? app.close())
    }
  }, 10_000)
}
