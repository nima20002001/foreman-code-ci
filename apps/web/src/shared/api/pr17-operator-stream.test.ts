import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeOperatorChat } from './operatorChatStream'
import { operatorState } from '../../features/operator-chat/pr17-test-fixtures'

class FakeEventSource extends EventTarget {
  static CLOSED = 2
  static current: FakeEventSource
  readyState = 1
  close = vi.fn()
  constructor() { super(); FakeEventSource.current = this }
}
afterEach(() => vi.unstubAllGlobals())
describe('PR17 stream connection reporting', () => {
  it('distinguishes transport loss from a live server error and ignores events after cleanup', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const listeners = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(), connection: vi.fn() }
    const stop = subscribeOperatorChat('conversation-one', listeners)
    const source = FakeEventSource.current
    source.dispatchEvent(new Event('error'))
    expect(listeners.connection).toHaveBeenLastCalledWith('reconnecting')
    source.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(operatorState()) }))
    expect(listeners.connection).toHaveBeenLastCalledWith('connected')
    source.dispatchEvent(new MessageEvent('error', { data: JSON.stringify({ id: 1, conversationId: 'conversation-one', type: 'error', data: { message: 'provider failed' } }) }))
    expect(listeners.event).toHaveBeenCalledOnce()
    expect(listeners.connection).toHaveBeenLastCalledWith('connected')
    stop()
    source.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(operatorState()) }))
    expect(listeners.snapshot).toHaveBeenCalledOnce()
    expect(source.close).toHaveBeenCalledOnce()
  })
  it('reports polling-only fallback instead of silently pretending a stream is connected', () => {
    vi.stubGlobal('EventSource', undefined)
    const listeners = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(), connection: vi.fn() }
    subscribeOperatorChat('conversation-one', listeners)()
    expect(listeners.connection).toHaveBeenCalledWith('unavailable')
  })
})
