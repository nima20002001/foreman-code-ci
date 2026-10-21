// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { subscribeMemoryBoard } from './stream'
import type { MemoryChange, MemoryStreamListeners } from './ports'

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = []
  closed = false
  constructor(readonly url: string) { super(); FakeEventSource.instances.push(this) }
  close() { this.closed = true }
}
function listeners(): MemoryStreamListeners {
  return { ready: vi.fn(), change: vi.fn(), reset: vi.fn(), connection: vi.fn() }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); FakeEventSource.instances = [] })
describe('memory event stream availability and ownership', () => {
  it('permits bounded HTTP readback when the browser begins offline', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const received = listeners()
    const stop = subscribeMemoryBoard('board', z.custom<MemoryChange>(), received)
    expect(received.connection).toHaveBeenLastCalledWith('offline')
    expect(received.ready).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.instances).toHaveLength(0)
    stop()
  })
  it('permits bounded HTTP readback when the browser goes offline before the stream opens', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const received = listeners()
    const stop = subscribeMemoryBoard('board', z.custom<MemoryChange>(), received)
    window.dispatchEvent(new Event('offline'))
    expect(received.connection).toHaveBeenLastCalledWith('offline')
    expect(received.ready).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.instances[0].closed).toBe(true)
    stop()
  })
  it('permits bounded HTTP readback when the stream fails before opening', () => {
    vi.useFakeTimers(); vi.stubGlobal('EventSource', FakeEventSource)
    const received = listeners()
    const stop = subscribeMemoryBoard('board', z.custom<MemoryChange>(), received)
    expect(received.ready).not.toHaveBeenCalled()
    FakeEventSource.instances[0].dispatchEvent(new Event('error'))
    expect(received.connection).toHaveBeenLastCalledWith('reconnecting')
    expect(received.ready).toHaveBeenCalledTimes(1)
    stop()
  })
  it('opens before requesting a snapshot and stops reconnecting after unsubscribe', () => {
    vi.useFakeTimers(); vi.stubGlobal('EventSource', FakeEventSource)
    const received = listeners()
    const stop = subscribeMemoryBoard('board', z.custom<MemoryChange>(), received)
    const source = FakeEventSource.instances[0]
    source.dispatchEvent(new Event('open'))
    expect(received.ready).toHaveBeenCalledTimes(1)
    expect(received.connection).toHaveBeenLastCalledWith('connected')
    stop(); source.dispatchEvent(new Event('error')); vi.advanceTimersByTime(31_000)
    expect(source.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(received.ready).toHaveBeenCalledTimes(1)
  })
})
