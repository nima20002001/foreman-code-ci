import { describe, expect, it, vi } from 'vitest'
import type { ClaudeMessageTurnInput } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import { ClaudeInputNotDeliveredError } from '../src/modules/harnesses/claudeSdk/port.js'
import { createStreamFixture, drainEvents, saved, start } from './claude-streams.testSupport.js'

describe('Claude stream admission and consumption', () => {
  it('survives paused consumers at both boundaries with permission and terminal events', async () => {
    const f = createStreamFixture({ outputCapacity: 2 })
    try {
      const session = await f.manager.attachSession(saved, start)
      const output = f.manager.startTurn(session, { prompt: 'stream', clientCorrelationId: 'request',
        callbackAuthority: { ownerPrincipalId: 'owner', attemptId: 'attempt' },
        onMessageSubmitted: f.onMessageSubmitted } as ClaudeMessageTurnInput)
      const query = f.queries[0]!
      const message = (await query.messages.next()).value!
      // Distinct text items fill the observer queue; subsequent frames fill runner output.
      await query.frames.offer(f.frame({ type: 'assistant', uuid: 'many-text-items', message: { id: 'reply',
        content: Array.from({ length: 300 }, (_, index) => ({ type: 'text', text: `text-${index}` })) } }, message.uuid))
      let finished = false
      const producer = (async () => {
        for (let index = 0; index < 10; index++) {
          await query.frames.offer(f.frame({ type: 'assistant', uuid: `extra-${index}`, message: { id: 'reply',
            content: [{ type: 'text', text: `extra-${index}` }] } }, message.uuid))
        }
        await query.frames.offer(f.frame({ type: 'assistant', uuid: 'tool-frame', message: { id: 'reply',
          content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: '/work/file' } }] } }, message.uuid))
        const decision = await f.callbacks.canUseTool!('Read', { file_path: '/work/file' }, {
          signal: new AbortController().signal, toolUseID: 'tool', requestId: 'permission' })
        expect(decision?.behavior).toBe('allow')
        await query.frames.offer(f.frame({ type: 'result', uuid: 'terminal', subtype: 'success',
          is_error: false, result: 'done' }, message.uuid))
        finished = true
      })()
      await vi.waitFor(() => expect(query.reads).toBeGreaterThanOrEqual(3))
      expect(query.reads).toBeLessThanOrEqual(4)
      expect(finished).toBe(false)
      expect(query.closed).toBe(false)
      const events = []
      for await (const event of output) {
        events.push(event)
        if (event.type === 'interaction.pending') {
          const pending = f.bridge.pendingInteractions(session)[0]!
          await f.manager.respond(session, 'permission', pending.responseOptions[0]!)
        }
      }
      await producer
      expect(events.filter(event => event.type === 'claude.text')).toHaveLength(310)
      expect(events.map(event => event.type)).toContain('interaction.pending')
      expect(events.at(-1)?.payload.result).toEqual({ outcome: 'succeeded', output: 'done' })
      expect((await f.manager.reconcile(session, 'request')).terminalResult?.outcome).toBe('succeeded')
      expect(query.closed).toBe(false)
    } finally { await f.manager.dispose?.() }
  })

  it('coalesces adjacent deltas without losing their prefix or the terminal event', async () => {
    const f = createStreamFixture({ outputCapacity: 2 })
    try {
      const session = await f.manager.attachSession(saved, start)
      const output = f.manager.startTurn(session, { prompt: 'stream', clientCorrelationId: 'coalesced',
        onMessageSubmitted: f.onMessageSubmitted } as ClaudeMessageTurnInput)
      const query = f.queries[0]!
      const message = (await query.messages.next()).value!
      const stream = (uuid: string, event: unknown) => query.frames.offer(f.frame({ type: 'stream_event', uuid, event }, message.uuid))
      await stream('start', { type: 'message_start', message: { id: 'streamed-message' } })
      await stream('block', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      for (let index = 0; index < 400; index++) {
        await stream(`delta-${index}`, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })
      }
      await vi.waitFor(() => expect(query.reads).toBe(402))
      await query.frames.offer(f.frame({ type: 'result', uuid: 'coalesced-result', subtype: 'success',
        is_error: false, result: 'done' }, message.uuid))
      const events = await drainEvents(output)
      const text = events.filter(event => event.type === 'claude.text')
      expect(text.length).toBeLessThan(400)
      expect(text.map(event => event.payload.text).join('')).toBe('x'.repeat(400))
      expect(text.at(-1)?.payload.truncation).toEqual({ truncated: false, originalBytes: 400 })
      expect(events.at(-1)?.payload.result).toEqual({ outcome: 'succeeded', output: 'done' })
    } finally { await f.manager.dispose?.() }
  })

  it.each([2, 256])('rejects %i retained inputs before installing a turn and resumes without replay', async capacity => {
    const f = createStreamFixture({ receiptCapacity: capacity })
    try {
      const session = await f.manager.attachSession(saved, start)
      const completed = Array.from({ length: capacity }, (_, index) => `request-${index}`)
      for (const correlationId of completed) {
        const events = drainEvents(f.manager.startTurn(session, { prompt: correlationId,
          clientCorrelationId: correlationId, onMessageSubmitted: f.onMessageSubmitted } as ClaudeMessageTurnInput))
        const message = (await f.queries[0]!.messages.next()).value!
        await f.complete(message, correlationId)
        await events
      }
      const next = { prompt: 'third', clientCorrelationId: 'third',
        callbackAuthority: { ownerPrincipalId: 'owner', attemptId: 'attempt' },
        onMessageSubmitted: f.onMessageSubmitted } as ClaudeMessageTurnInput
      expect(() => f.manager.startTurn(session, next)).toThrow(ClaudeInputNotDeliveredError)
      expect(() => f.manager.startTurn(session, next)).toThrow(ClaudeInputNotDeliveredError)
      expect((await f.manager.reconcile(session, 'third')).nativeSubmission).toBeUndefined()
      const resumed = await f.manager.attachSession(session, start)
      expect(f.queries).toHaveLength(2)
      expect(f.queries[0]!.closed).toBe(true)
      expect(f.queries[1]!.options.resume).toBe(session.nativeSessionId)
      expect((await f.manager.reconcile(resumed, 'request-0')).terminalResult?.output).toBe('request-0')
      expect(() => f.manager.startTurn(resumed, { prompt: 'request-0', clientCorrelationId: 'request-0' })).toThrow('already offered')
      const output = drainEvents(f.manager.startTurn(resumed, next))
      const message = (await f.queries[1]!.messages.next()).value!
      expect(message.message.content).toBe('third')
      await f.queries[1]!.frames.offer(f.frame({ type: 'assistant', uuid: 'resumed-tool',
        message: { id: 'resumed-message', content: [{ type: 'tool_use', id: 'resumed-tool', name: 'Read', input: {} }] } }, message.uuid))
      const decision = f.callbacks.canUseTool!('Read', {}, { signal: new AbortController().signal,
        toolUseID: 'resumed-tool', requestId: 'resumed-permission' })
      await vi.waitFor(() => expect(f.bridge.pendingInteractions(resumed)).toHaveLength(1))
      await f.manager.respond(resumed, 'resumed-permission', f.bridge.pendingInteractions(resumed)[0]!.responseOptions[0]!)
      expect((await decision)?.behavior).toBe('allow')
      await f.complete(message, 'third')
      expect((await output).at(-1)?.payload.result).toEqual({ outcome: 'succeeded', output: 'third' })
    } finally { await f.manager.dispose?.() }
  })

  it('retains replay checks when a capacity rollover fails and is retried', async () => {
    const f = createStreamFixture({ receiptCapacity: 1, resumeFailures: 1 })
    try {
      const session = await f.manager.attachSession(saved, start)
      const output = drainEvents(f.manager.startTurn(session, { prompt: 'first', clientCorrelationId: 'first',
        onMessageSubmitted: f.onMessageSubmitted } as ClaudeMessageTurnInput))
      const message = (await f.queries[0]!.messages.next()).value!
      await f.complete(message, 'first')
      await output
      await expect(f.manager.attachSession(session, start)).rejects.toThrow('Resume unavailable')
      const resumed = await f.manager.attachSession(session, start)
      expect(() => f.manager.startTurn(resumed, { prompt: 'first', clientCorrelationId: 'first' })).toThrow('already offered')
      expect((await f.manager.reconcile(resumed, 'first')).terminalResult?.output).toBe('first')
      const next = drainEvents(f.manager.startTurn(resumed, { prompt: 'next', clientCorrelationId: 'next',
        callbackAuthority: { ownerPrincipalId: 'owner', attemptId: 'attempt' },
        onMessageSubmitted: f.onMessageSubmitted } as ClaudeMessageTurnInput))
      const input = (await f.queries[1]!.messages.next()).value!
      await f.queries[1]!.frames.offer(f.frame({ type: 'assistant', uuid: 'retry-tool',
        message: { id: 'retry-message', content: [{ type: 'tool_use', id: 'retry-tool', name: 'Read', input: {} }] } }, input.uuid))
      const decision = f.callbacks.canUseTool!('Read', {}, { signal: new AbortController().signal,
        toolUseID: 'retry-tool', requestId: 'retry-permission' })
      await vi.waitFor(() => expect(f.bridge.pendingInteractions(resumed)).toHaveLength(1))
      await f.manager.respond(resumed, 'retry-permission', f.bridge.pendingInteractions(resumed)[0]!.responseOptions[0]!)
      expect((await decision)?.behavior).toBe('allow')
      await f.complete(input, 'next')
      expect((await next).at(-1)?.payload.result).toEqual({ outcome: 'succeeded', output: 'next' })
    } finally { await f.manager.dispose?.() }
  })
})
