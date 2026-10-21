import { deferred } from '../../test/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { subscribeOperatorChat } from './operatorChatStream'
class Source extends EventTarget {
  static OPEN = 1
  static CLOSED = 2
  static current: Source
  readyState = 1
  close = vi.fn()
  constructor() { super(); Source.current = this }
  snapshot() { this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify({ conversation: { id: 'chat', agentId: 'operator', scope: 'application', operatorConfigurationVersionId: 'config', status: 'open' }, messages: [], activeRequestId: 'A', turnState: 'active', revision: 100 }) })) }
  event(id: number) { this.dispatchEvent(new MessageEvent('delta', { data: JSON.stringify({ id, conversationId: 'chat', type: 'delta', data: {} }) })) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('requires a fresh bootstrap, deduplicates and repairs gaps without comparing SSE IDs to scope revisions', () => {
  vi.stubGlobal('EventSource', Source)
  const calls = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(), connection: vi.fn() }
  const close = subscribeOperatorChat('chat', calls), source = Source.current
  source.event(50); expect(calls.event).not.toHaveBeenCalled()
  source.snapshot(); source.event(1); source.event(1); source.event(3)
  expect(calls.event).toHaveBeenCalledTimes(2); expect(calls.reconnect).toHaveBeenCalledTimes(2)
  source.dispatchEvent(new Event('open')); source.event(0)
  expect(calls.event).toHaveBeenCalledTimes(2)
  source.snapshot(); source.event(0); expect(calls.event).toHaveBeenCalledTimes(3)
  close(); source.snapshot(); source.event(4); expect(calls.snapshot).toHaveBeenCalledTimes(2)
})

it('projects consecutive conversation-local events without resetting the live connection', () => {
  vi.stubGlobal('EventSource', Source)
  const calls = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(), connection: vi.fn() }
  const close = subscribeOperatorChat('chat', calls)
  try {
    Source.current.snapshot()
    Source.current.event(0)
    Source.current.event(1)
    expect(calls.event.mock.calls.map(([event]) => event.id)).toEqual([0, 1])
    expect(calls.reconnect).not.toHaveBeenCalled()
    expect(calls.connection).toHaveBeenLastCalledWith('connected')
  } finally { close() }
})


it('caps terminal recovery backoff and stops recovery on disposal', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('EventSource', Source)
  const callbacks = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(), connection: vi.fn(),
    recover: vi.fn().mockRejectedValue(new Error('Temporary outage')) }
  const close = subscribeOperatorChat('chat', callbacks)
  Source.current.readyState = Source.CLOSED
  Source.current.dispatchEvent(new Event('error'))
  for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(callbacks.recover).toHaveBeenCalledTimes(index)
    await vi.advanceTimersByTimeAsync(1)
    expect(callbacks.recover).toHaveBeenCalledTimes(index + 1)
  }
  await vi.advanceTimersByTimeAsync(10_000)
  expect(callbacks.recover).toHaveBeenCalledTimes(7)
  close()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(callbacks.recover).toHaveBeenCalledTimes(7)
  expect(Source.current.close).toHaveBeenCalledOnce()
})

it('waits for connectivity before replacing a terminal source', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('EventSource', Source)
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  const callbacks = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(), connection: vi.fn(),
    recover: vi.fn().mockResolvedValue(undefined) }
  const close = subscribeOperatorChat('chat', callbacks)
  const original = Source.current
  original.readyState = Source.CLOSED
  original.dispatchEvent(new Event('error'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(callbacks.recover).not.toHaveBeenCalled()
  online.mockReturnValue(true)
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(1_000)
  expect(callbacks.recover).toHaveBeenCalledOnce()
  expect(Source.current).not.toBe(original)
  close()
  expect(Source.current.close).toHaveBeenCalledOnce()
})


it('coalesces connectivity notifications while terminal readback is still pending', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('EventSource', Source)
  const pending = deferred<void>()
  const callbacks = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(),
    recover: vi.fn(() => pending.promise) }
  const close = subscribeOperatorChat('chat', callbacks)
  Source.current.readyState = Source.CLOSED
  Source.current.dispatchEvent(new Event('error'))
  await vi.advanceTimersByTimeAsync(1_000)
  window.dispatchEvent(new Event('online'))
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(callbacks.recover).toHaveBeenCalledOnce()
  pending.resolve()
  await vi.advanceTimersByTimeAsync(0)
  close()
})

it.each([401, 403, 404])('stops terminal recovery after a definitive HTTP %s response', async status => {
  vi.useFakeTimers()
  vi.stubGlobal('EventSource', Source)
  const callbacks = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(), connection: vi.fn(),
    recover: vi.fn().mockRejectedValue(new ApiError({ code: 'UNAVAILABLE', message: 'Conversation unavailable' }, status)) }
  const close = subscribeOperatorChat('chat', callbacks)
  Source.current.readyState = Source.CLOSED
  Source.current.dispatchEvent(new Event('error'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(callbacks.recover).toHaveBeenCalledOnce()
  expect(callbacks.connection).toHaveBeenLastCalledWith('unavailable')
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(60000)
  expect(callbacks.recover).toHaveBeenCalledOnce()
  expect(Source.current.close).toHaveBeenCalledOnce()
  close()
})
