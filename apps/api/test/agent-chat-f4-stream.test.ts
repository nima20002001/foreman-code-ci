import { EventEmitter } from 'node:events'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentChatFixtures, type AgentChatState, type AgentChatStreamEvent } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { AgentChatEvents, type AgentChatService } from '../src/modules/conversations/agentChat.js'
import { AGENT_CHAT_FRAME_BYTES, agentChatStreamFrame } from '../src/modules/conversations/agentChatStream.js'
import { registerAgentChatRoutes } from '../src/routes/agentChat.js'

const owner: ManagementPrincipal = { id: 'f4-stream', name: 'F4', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['agent_chat:read'], scope: {} }] }
const id = agentChatFixtures.active.conversation.id

/** Exercise the actual route handler/writer with an instrumented socket; no app/DB/provider is started. */
function route(read = async (): Promise<AgentChatState> => structuredClone(agentChatFixtures.active), writeFails = false) {
  let handler!: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  const app = { addHook: vi.fn(), post: vi.fn(), get: (path: string, callback: typeof handler) => { if (path.endsWith('/events')) handler = callback } }
  const events = new AgentChatEvents()
  let subscriptions = 0
  const originalSubscribe = events.subscribe.bind(events)
  events.subscribe = (conversationId, listener) => {
    subscriptions++
    const remove = originalSubscribe(conversationId, listener)
    let removed = false
    return () => { if (!removed) { removed = true; subscriptions--; remove() } }
  }
  const chat = { events, readConversation: vi.fn(read), assertReadable: vi.fn(async () => undefined) }
  registerAgentChatRoutes(app as unknown as FastifyInstance, chat as unknown as AgentChatService)
  const frames: string[] = []
  const raw = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, headersSent: false,
    write: (frame: string) => { if (writeFails) throw new Error('socket failed'); frames.push(frame); return true },
    writeHead: () => { raw.headersSent = true }, end: () => { raw.writableEnded = true; raw.emit('close') },
  })
  const request = { params: { workspaceId: agentChatFixtures.active.context.workspaceId, conversationId: id },
    operatorPrincipal: owner, reauthorizeOperator: vi.fn(async () => owner) }
  const reply = { raw, hijack: vi.fn() }
  return { open: () => handler(request as unknown as FastifyRequest, reply as unknown as FastifyReply),
    events, chat, request, frames, raw, subscriptions: () => subscriptions }
}

afterEach(() => { vi.useRealTimers() })

describe('F4 A-R17 byte-bounded Agent chat SSE lifecycle', () => {
  it('uses an honest readback invalidation for oversized results/messages without truncation', () => {
    for (const type of ['snapshot', 'message', 'activity'] as const) {
      const data = { text: '界'.repeat(3 * 1024 * 1024) }
      const event: AgentChatStreamEvent = { id: 17, conversationId: id, type, data }
      const frame = agentChatStreamFrame(event)
      expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(AGENT_CHAT_FRAME_BYTES)
      expect(frame).toContain('event: state')
      expect(frame).toContain('"snapshotRequired":true')
      expect(frame).toContain('id: 17')
      expect(event.data).toEqual(data)
    }
  })

  it('reconnects with usable frames and leaves no subscriptions or timers after close', async () => {
    vi.useFakeTimers()
    const snapshot: AgentChatState = { ...agentChatFixtures.active,
      lastResult: { outcome: 'succeeded', output: { text: 'x'.repeat(9 * 1024 * 1024) } } }
    for (let connection = 0; connection < 3; connection++) {
      const f = route(async () => snapshot)
      await f.open()
      expect(f.frames[0]).toContain('event: state')
      expect(f.subscriptions()).toBe(1)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(f.frames.at(-1)).toBe(': heartbeat\n\n')
      f.raw.emit('close')
      expect(f.subscriptions()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(f.raw.listenerCount('close') + f.raw.listenerCount('error') + f.raw.listenerCount('drain')).toBe(0)
    }
  })

  it('does not install a heartbeat after the initial socket write stops the writer', async () => {
    vi.useFakeTimers()
    const f = route(undefined, true)
    await f.open()
    expect(f.subscriptions()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.raw.writableEnded).toBe(true)
  })

  it('bounds bootstrap bytes independently of frame count and cleans up failed initialization', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = route(async () => { await gate; return agentChatFixtures.active })
    const opened = f.open()
    // Two individually valid frames exceed the 256 KiB aggregate budget, well below 128 frames.
    f.events.publish(id, 'delta', { text: '界'.repeat(50_000) })
    f.events.publish(id, 'delta', { text: '界'.repeat(50_000) })
    expect(f.subscriptions()).toBe(0)
    release()
    await expect(opened).rejects.toMatchObject({ code: 'STREAM_RECONNECT_REQUIRED' })
    expect(f.frames).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reauthorizes at initialization and heartbeat and stops on lost scoped access', async () => {
    vi.useFakeTimers()
    const f = route()
    await f.open()
    expect(f.request.reauthorizeOperator).toHaveBeenCalledTimes(1)
    expect(f.chat.assertReadable).toHaveBeenCalledWith(owner, agentChatFixtures.active.context.workspaceId, id)
    f.chat.assertReadable.mockRejectedValueOnce(new Error('scope revoked'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.request.reauthorizeOperator).toHaveBeenCalledTimes(2)
    expect(f.subscriptions()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.frames).toHaveLength(1)
  })
})
