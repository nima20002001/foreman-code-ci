import { expect, it } from 'vitest'
import { SessionPreferencesSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { normalizeNativeTextOperations } from '../../conversations/nativeTextStream.js'
import { claudeNativeEvent } from './nativeEvents.js'
import { createClaudeEventNormalizer } from './normalization.js'
import type { ClaudeSdkUserMessage } from './port.js'
import { ClaudeBoundedQueue } from './queue.js'
import { drain, fixture, start } from './__tests__/sessionManager.js'

function transportFixture() {
  return fixture(() => {
    const normalizer = createClaudeEventNormalizer({
      owner: { ownerId: 'sender', attemptId: 'conversation', generation: 'decoder-owner' },
      observedAt: () => '2026-10-17T00:00:00.000Z',
    })
    return raw => normalizer.ingest(raw).map(event => claudeNativeEvent(event, 0))
  })
}

async function completeTurn(f: ReturnType<typeof transportFixture>, session: NativeSessionReference,
  correlationId: string, frames = f.frames, nextMessage = f.nextMessage) {
  const output = drain(f.manager.startTurn(session, { prompt: 'Reply', clientCorrelationId: correlationId }))
  const message = await nextMessage()
  const common = { session_id: session.nativeSessionId, user_message_uuid: message.uuid, parent_tool_use_id: null }
  const messageId = `answer-${correlationId}`
  await frames.offer({ ...common, type: 'stream_event', uuid: `${correlationId}-start`,
    event: { type: 'message_start', message: { id: messageId, role: 'assistant', content: [] } } })
  await frames.offer({ ...common, type: 'stream_event', uuid: `${correlationId}-block`,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await frames.offer({ ...common, type: 'stream_event', uuid: `${correlationId}-delta`,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial reply' } } })
  await frames.offer({ ...common, type: 'assistant', uuid: `${correlationId}-answer`,
    message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: 'Partial reply' }] } })
  await frames.offer({ ...common, type: 'result', uuid: `${correlationId}-result`,
    subtype: 'success', is_error: false, result: 'Partial reply' })
  return output
}

it('preserves query transport order in text operations and history across turns and SDK resume', async () => {
  const f = transportFixture()
  const session: NativeSessionReference = {
    harness: 'claude', providerVersion: '2.1.284', nativeSessionId: 'native-session',
  }
  try {
    await f.manager.attachSession(session, start)
    const first = await completeTurn(f, session, 'first')
    const second = await completeTurn(f, session, 'second')
    const connectionId = first[0]!.connectionId
    expect(connectionId).toEqual(expect.any(String))
    expect(new Set([...first, ...second].map(event => event.connectionId))).toEqual(new Set([connectionId]))
    const partial = first.find(event => event.type === 'claude.text' && event.payload.text === 'Partial reply')!
    expect(partial.payload).toMatchObject({ operation: 'append', final: false, source: { eventId: 'first-delta' } })
    const [operation] = normalizeNativeTextOperations(partial, { harness: 'claude', parents: new Map(),
      owner: () => ({ scope: { kind: 'operator_chat', conversationId: 'conversation', requestId: 'first' },
        requestId: 'first', sessionId: session.nativeSessionId }) })
    expect(operation?.source).toEqual({ connectionId, sequence: partial.sequence, eventId: 'first-delta' })
    expect(partial.payload.source).not.toHaveProperty('sequence')
    expect((await f.manager.reconcile(session, 'first')).events).toEqual(first)

    const frames = new ClaudeBoundedQueue<unknown>(32)
    let messages!: AsyncIterator<ClaudeSdkUserMessage>
    f.client.query = input => {
      f.queries(input)
      messages = input.prompt[Symbol.asyncIterator]()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), interrupt: async () => {},
        initializationResult: async () => ({ models: [], account: {} }), close: () => frames.close() }
    }
    await f.manager.applySessionPreferences!(session, SessionPreferencesSchema.parse({ autoCompact: 'off' }))
    const resumed = await completeTurn(f, session, 'resumed', frames, async () => (await messages.next()).value!)
    const resumedConnection = resumed[0]!.connectionId
    expect(resumedConnection).toEqual(expect.any(String))
    expect(resumedConnection).not.toBe(connectionId)
    expect(new Set(resumed.map(event => event.connectionId))).toEqual(new Set([resumedConnection]))
    const events = [...first, ...second, ...resumed]
    expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true)
    const history = await f.manager.history(session)
    expect(history.events.filter(event => event.payload.clientCorrelationId)).toEqual(events)
    expect((await f.manager.reconcile(session, 'first')).events).toEqual(first)
    expect(f.queries).toHaveBeenCalledTimes(2)
  } finally { await f.manager.dispose?.() }
})
