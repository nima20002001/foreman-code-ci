import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentChatFixtures, type AgentChatStreamEvent } from '@foreman-code/contracts/agent-chat'
import { subscribeAgentChat } from './agentChatStream'
import { AgentChatTestSource, installChatSource } from '../../features/conversations/agentChat/testSupport'

describe('Agent chat SSE transport', () => {
  let close: (() => void) | undefined
  beforeEach(() => { installChatSource(); vi.useFakeTimers() })
  afterEach(() => { close?.(); vi.useRealTimers(); vi.unstubAllGlobals() })
  const listeners = () => ({ snapshot: vi.fn(), event: vi.fn(), refetch: vi.fn(), connection: vi.fn() })
  const state = agentChatFixtures.active
  it('waits for a contract snapshot, rejects foreign identity and cleans up on close', () => {
    const calls = listeners(); close = subscribeAgentChat('workspace-fixture', state.conversation.id, calls)
    const source = AgentChatTestSource.instances[0]!
    expect(source.url).toBe('/api/workspaces/workspace-fixture/agent-chat/conversations/agent-conversation-fixture/events')
    source.open(); expect(calls.refetch).toHaveBeenCalledOnce()
    source.snapshot(state); expect(calls.snapshot).toHaveBeenCalledWith(state)
    source.event({ id: 1, conversationId: 'foreign-conversation', type: 'delta', data: {} })
    expect(calls.event).not.toHaveBeenCalled()
    expect(source.close).toHaveBeenCalledOnce()
    close(); vi.runAllTimers(); expect(AgentChatTestSource.instances).toHaveLength(1)
  })
  it('deduplicates every event kind and repairs out-of-order events with a read', () => {
    const calls = listeners(); close = subscribeAgentChat('workspace-fixture', state.conversation.id, calls)
    const source = AgentChatTestSource.instances[0]!; source.snapshot(state)
    const types: AgentChatStreamEvent['type'][] = ['delta', 'message', 'activity', 'turn', 'state', 'error']
    types.forEach((type, index) => {
      const event = { id: index + 3, type, conversationId: state.conversation.id, data: {} }
      source.event(event); source.event(event)
    })
    expect(calls.event).toHaveBeenCalledTimes(types.length)
    source.event({ id: 2, type: 'delta', conversationId: state.conversation.id, data: {} })
    expect(calls.refetch).toHaveBeenCalledOnce()
    expect(calls.event).toHaveBeenCalledTimes(types.length)
  })
  it('accepts an oversized-snapshot state notice as live and reads state over HTTP instead of reconnecting', () => {
    const calls = listeners(); close = subscribeAgentChat('workspace-fixture', state.conversation.id, calls)
    const source = AgentChatTestSource.instances[0]!
    source.event({ id: 0, type: 'state', conversationId: state.conversation.id, data: { snapshotRequired: true } })
    expect(calls.refetch).toHaveBeenCalledOnce()
    expect(calls.connection).toHaveBeenCalledWith('connected')
    source.event({ id: 1, type: 'turn', conversationId: state.conversation.id, data: {} })
    expect(calls.event).toHaveBeenCalledOnce()
    vi.runAllTimers(); expect(AgentChatTestSource.instances).toHaveLength(1)
  })
  it('uses exponential backoff and resets only after a valid snapshot', () => {
    const calls = listeners(); close = subscribeAgentChat('workspace-fixture', state.conversation.id, calls)
    AgentChatTestSource.instances[0]!.fail()
    vi.advanceTimersByTime(499); expect(AgentChatTestSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(1); expect(AgentChatTestSource.instances).toHaveLength(2)
    AgentChatTestSource.instances[1]!.fail()
    vi.advanceTimersByTime(999); expect(AgentChatTestSource.instances).toHaveLength(2)
    vi.advanceTimersByTime(1); expect(AgentChatTestSource.instances).toHaveLength(3)
    AgentChatTestSource.instances[2]!.snapshot(state); AgentChatTestSource.instances[2]!.fail()
    vi.advanceTimersByTime(500); expect(AgentChatTestSource.instances).toHaveLength(4)
  })
  it('does not treat a native error payload as a disconnected transport', () => {
    const calls = listeners(); close = subscribeAgentChat('workspace-fixture', state.conversation.id, calls)
    const source = AgentChatTestSource.instances[0]!; source.snapshot(state)
    source.event({ id: 1, conversationId: state.conversation.id, type: 'error', data: { message: 'Native turn failed' } })
    expect(calls.event).toHaveBeenCalledOnce(); expect(source.close).not.toHaveBeenCalled()
    expect(calls.connection).toHaveBeenLastCalledWith('connected')
  })
  it('malformed payloads and deltas before a snapshot request a new snapshot', () => {
    const calls = listeners(); close = subscribeAgentChat('workspace-fixture', state.conversation.id, calls)
    AgentChatTestSource.instances[0]!.event({ id: 1, conversationId: state.conversation.id, type: 'delta', data: {} })
    expect(calls.event).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    AgentChatTestSource.instances[1]!.dispatchEvent(new MessageEvent('snapshot', { data: 'not JSON' }))
    expect(calls.snapshot).not.toHaveBeenCalled()
    expect(calls.refetch).toHaveBeenCalledTimes(2)
  })
  it('supports completed-message polling fallback when EventSource is unavailable', () => {
    vi.stubGlobal('EventSource', undefined)
    const calls = listeners(); close = subscribeAgentChat('workspace-fixture', state.conversation.id, calls)
    expect(calls.connection).toHaveBeenCalledWith('unavailable')
  })
})

describe('stream generation barriers', () => {
  it('restarts from a fresh snapshot after reset ephemeral counters and ignores disposed source callbacks', () => {
    installChatSource(); vi.useFakeTimers()
    const calls = { snapshot: vi.fn(), event: vi.fn(), refetch: vi.fn(), connection: vi.fn() }
    const state = agentChatFixtures.activeWithQueue
    const close = subscribeAgentChat('workspace-fixture', state.conversation.id, calls)
    const old = AgentChatTestSource.instances[0]!
    old.snapshot(state, 50); old.fail(); vi.advanceTimersByTime(500)
    const current = AgentChatTestSource.instances[1]!
    current.snapshot(state, 0)
    old.snapshot(agentChatFixtures.idleAfterCompletion, 100)
    old.event({ id: 101, conversationId: state.conversation.id, type: 'delta', data: {} })
    expect(calls.snapshot).toHaveBeenCalledTimes(2)
    expect(calls.snapshot).toHaveBeenLastCalledWith(state)
    expect(calls.event).not.toHaveBeenCalled()
    close(); current.snapshot(state, 1); vi.runAllTimers()
    expect(calls.snapshot).toHaveBeenCalledTimes(2)
    vi.useRealTimers(); vi.unstubAllGlobals()
  })
})


it('does not notify or create a retry timer after a listener disposes the subscription', () => {
  installChatSource(); vi.useFakeTimers()
  const calls = { snapshot: vi.fn(), event: vi.fn(), refetch: vi.fn(), connection: vi.fn() }
  const state = agentChatFixtures.active
  const close = subscribeAgentChat('workspace-fixture', state.conversation.id, { ...calls, snapshot: () => close() })
  AgentChatTestSource.instances[0]!.snapshot(state)
  expect(calls.connection).not.toHaveBeenCalledWith('connected')
  const stop = subscribeAgentChat('workspace-fixture', state.conversation.id, { ...calls, refetch: () => stop() })
  AgentChatTestSource.instances[1]!.fail()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers(); vi.unstubAllGlobals()
})
