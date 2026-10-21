import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { createClaudeSdkCallbacks } from './sdkCallbacks.js'
import { ClaudeInteractionBridge } from './interactions.js'
import type { ClaudeMessageTurnInput } from './sessionManager.js'
import { memoryClaudeCallbackJournal } from '../../../../test/support/claudeCallbackJournal.js'
import { fixture, start } from './__tests__/sessionManager.js'

it.each(['eof', 'failure'] as const)('owns full-queue callback publication on SDK %s', async ending => {
  const f = fixture(() => raw => {
    const frame = raw as { type: string; session_id?: string }
    if (frame.type !== 'assistant') return []
    return Array.from({ length: 255 }, (_, index) => ({ type: 'claude.tool', payload: {
      nativeSessionId: frame.session_id, messageId: 'assistant-message', toolUseId: `tool-${index}`,
    } }))
  }, { pendingInteractions: session => bridge.pendingInteractions(session) })
  const bridge: ClaudeInteractionBridge = new ClaudeInteractionBridge({ harness: 'claude', model: 'fixture', authMode: 'subscription',
    configDirectory: '/profile', permissionMode: 'default', sandbox: 'danger-full-access',
    tools: ['Read'], permissionRules: [{ tool: 'Read', effect: 'ask' }], instructions: '', mcpServers: {} },
  { callbackJournal: memoryClaudeCallbackJournal(), validate: async () => undefined,
    validateResponse: async () => undefined, request: identity => bridge.waitForResponse(identity) })
  const unsubscribe = bridge.subscribePending(notification => f.manager.notifyPendingChanged(notification))
  let permission: ReturnType<NonNullable<ReturnType<typeof createClaudeSdkCallbacks>['canUseTool']>> | undefined
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  let observer: AsyncIterator<import('@foreman-code/contracts').NativeHarnessEvent> | undefined
  try {
    const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
      nativeSessionId: 'native-session' }, start)
    observer = f.manager.startTurn(session, { prompt: 'Read a file', clientCorrelationId: 'callback-request',
      callbackAuthority: { ownerPrincipalId: 'owner', attemptId: 'attempt' } } as ClaudeMessageTurnInput)[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    await f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'assistant-frame',
      user_message_uuid: message.uuid, message: { id: 'assistant-message', content: [] } })
    await vi.waitFor(async () => expect((await f.manager.history(session)).events)
      .toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ toolUseId: 'tool-254' }) })))
    const context = f.manager.nativeCallbackContext(session.nativeSessionId, 'tool-0')!
    expect(context).toBeDefined()
    f.manager.notifyPendingChanged({ ...context, generation: 'stale', nativeRequestId: 'foreign',
      nativeRequestType: 'can_use_tool' })
    const callbacks = createClaudeSdkCallbacks({ manager: () => f.manager, bridge })
    permission = callbacks.canUseTool!('Read', { file_path: '/work/file' },
      { signal: new AbortController().signal, toolUseID: 'tool-0', requestId: 'permission-request' })
    await vi.waitFor(() => expect(bridge.pendingInteractions(session)).toHaveLength(1))
    await callbacks.hooks!.SubagentStart![0]!.hooks[0]!({ hook_event_name: 'SubagentStart',
      session_id: session.nativeSessionId, agent_id: 'child', agent_type: 'reviewer',
      transcript_path: '/native/transcript', cwd: '/work' } as HookInput, undefined,
    { signal: new AbortController().signal })
    const history = await f.manager.history(session)
    expect(history.events).toContainEqual(expect.objectContaining({ type: 'interaction.pending',
      payload: expect.objectContaining({ nativeRequestId: 'permission-request' }) }))
    expect(history.events.some(event => event.payload.nativeRequestId === 'foreign')).toBe(false)
    expect(history.events).toContainEqual(expect.objectContaining({ type: 'claude.subagent',
      payload: expect.objectContaining({ agentId: 'child' }) }))
    expect(history.events.length).toBeLessThanOrEqual(256)
    f.frames.close(ending === 'failure' ? new Error('Native stream failed') : undefined)
    await vi.waitFor(() => expect(f.manager.nativeCallbackContext(session.nativeSessionId, 'tool-0')).toBeUndefined())
    await new Promise<void>(resolve => setImmediate(resolve))
    const failures = unhandled.mock.calls.length
    let observerFailure: unknown
    try { while (!(await observer.next()).done) { /* Drain retained events before the stream error. */ } }
    catch (error) { observerFailure = error }
    expect(observerFailure).toBeInstanceOf(Error)
    expect(failures).toBe(0)
  } finally {
    unsubscribe()
    bridge.close()
    await permission
    await observer?.return?.()
    await f.manager.dispose!()
    process.off('unhandledRejection', unhandled)
  }
})
