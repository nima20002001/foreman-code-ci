import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { OperatorConversationEvents } from '../src/modules/conversations/operatorChat.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'

const principal = (): ManagementPrincipal => ({ id: 'stream-owner', name: 'Stream owner', audience: 'operator',
  grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null })
const snapshot = { conversation: { id: 'conversation-stream', agentId: 'application-operator', scope: 'application',
  operatorConfigurationVersionId: 'operator-config', status: 'open' }, messages: [], turnState: 'idle', revision: 0, activeRequestId: null }

function fixture(get = async () => snapshot) {
  const app = Fastify()
  const owner = principal()
  app.addHook('preHandler', async (request) => {
    request.operatorPrincipal = owner
    request.reauthorizeOperator = async () => {
      if (owner.revokedAt) throw new Error('Revoked')
      return owner
    }
  })
  const chat = { events: new OperatorConversationEvents(), get, assertAccess: async () => ({}) }
  registerOperatorChatRoutes(app, chat as never)
  return { app, chat, owner }
}

describe('Operator chat SSE lifecycle', () => {
  it('closes hijacked streams before Fastify waits for open connections', async () => {
    const { app } = fixture()
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    try {
      const response = await fetch(`${address}/api/operator/conversations/conversation-stream/events`)
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot')
      await expect(Promise.race([app.close().then(() => 'closed'),
        new Promise<string>((resolve) => { const timer = setTimeout(() => resolve('timeout'), 1_000); timer.unref() }),
      ])).resolves.toBe('closed')
      expect((await reader.read()).done).toBe(true)
    } finally { await app.close() }
  })

  it('queues completion during snapshot initialization rather than missing it', async () => {
    let release!: () => void
    let ready!: () => void
    const started = new Promise<void>((resolve) => { ready = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { app, chat } = fixture(async () => { ready(); await gate; return snapshot })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    try {
      const opening = fetch(`${address}/api/operator/conversations/conversation-stream/events`, { headers: { 'last-event-id': '999' } })
      await started
      chat.events.publish('conversation-stream', 'message', { requestId: 'finished-during-read' })
      release()
      const response = await opening
      const reader = response.body!.getReader()
      let text = ''
      while (!text.includes('finished-during-read')) text += new TextDecoder().decode((await reader.read()).value)
      expect(text.indexOf('event: snapshot')).toBeLessThan(text.indexOf('event: message'))
      expect(text).toContain('id: 0') // Reconnect always supplies current state, not a guessed transient cursor.
      await reader.cancel()
    } finally { release(); await app.close() }
  })

  it('does not write a new event after credential expiry', async () => {
    const { app, chat, owner } = fixture()
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    try {
      const response = await fetch(`${address}/api/operator/conversations/conversation-stream/events`)
      const reader = response.body!.getReader()
      await reader.read()
      owner.expiresAt = new Date(0).toISOString()
      chat.events.publish('conversation-stream', 'delta', { text: 'must not be disclosed' })
      expect((await reader.read()).done).toBe(true)
    } finally { await app.close() }
  })
})

it('numbers only events delivered to this conversation, even when other chats publish between them', async () => {
  const { app, chat } = fixture()
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(`${address}/api/operator/conversations/conversation-stream/events`)
    reader = response.body!.getReader()
    await reader.read()
    chat.events.publish('conversation-stream', 'delta', { text: 'first' })
    chat.events.publish('another-chat', 'delta', { text: 'private' })
    chat.events.publish('conversation-stream', 'delta', { text: 'second' })
    let wire = ''
    while (!wire.includes('second')) wire += new TextDecoder().decode((await reader.read()).value)
    const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    expect(events.map(event => event.id)).toEqual([0, 1])
    expect(events.map(event => event.data.text)).toEqual(['first', 'second'])
    expect(wire).not.toContain('private')
  } finally { await reader?.cancel(); await app.close() }
})
