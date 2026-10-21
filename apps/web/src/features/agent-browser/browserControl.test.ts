import { describe, expect, it, vi } from 'vitest'
import { BrowserController } from './controller'
import { browserPortFake, browserRead, deferred, frame } from './testFixtures'
import type { BrowserControl } from './types'

const click = { kind: 'pointer', phase: 'down', x: 20, y: 10, button: 0, buttons: 1 } as const

describe('browser control admission', () => {
  it('uses a new takeover command after a definite rejection and requires explicit recovery after an uncertain response', async () => {
    const fake = browserPortFake()
    const controller = new BrowserController(fake.port, browserRead(), browserRead().tabs[0]!, 'retry-viewer', vi.fn())
    await controller.start(); fake.observer!.frame(frame())
    vi.mocked(fake.port.acquire).mockRejectedValueOnce(Object.assign(new Error('Another viewer controls this browser'), { outcome: 'rejected', status: 409 }))
    await expect(controller.acquire()).rejects.toThrow()
    fake.observer!.frame(frame('session', 'tab', 1))
    vi.mocked(fake.port.acquire).mockRejectedValueOnce(new Error('Response lost'))
    await expect(controller.acquire()).rejects.toThrow()
    fake.observer!.frame(frame('session', 'tab', 2))
    await expect(controller.acquire()).rejects.toThrow('Reconnect')
    const commands = vi.mocked(fake.port.acquire).mock.calls.map(call => call[2])
    expect(commands).toHaveLength(2)
    expect(commands[0]).not.toBe(commands[1])
    expect(controller.getSnapshot()).toMatchObject({ notice: 'paused', stale: true, pendingInputs: 0 })
    await controller.close()
  })

  it('leaves a healthy agent-owned watcher alone when focus moves outside the view', async () => {
    const fake = browserPortFake()
    const controller = new BrowserController(fake.port, browserRead(), browserRead().tabs[0]!, 'watcher', vi.fn())
    await controller.start(); fake.observer!.frame(frame())
    await controller.release()
    expect(fake.port.release).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({ notice: 'watching', stale: false })
    await controller.close()
  })

  it('buffers the opening click through host epoch notifications and ordinary animated frames until user acknowledgement', async () => {
    const fake = browserPortFake(), pending = deferred<BrowserControl>()
    vi.mocked(fake.port.acquire).mockReturnValue(pending.promise)
    const controller = new BrowserController(fake.port, browserRead(), browserRead().tabs[0]!, 'viewer', vi.fn())
    await controller.start(); fake.observer!.frame(frame())
    const input = controller.send(click)
    expect(fake.port.input).not.toHaveBeenCalled()
    fake.observer!.control({ sessionId: 'session', state: 'quiescing', epoch: 1, controllingViewerId: 'viewer', reason: null })
    fake.observer!.frame(frame('session', 'tab', 1))
    pending.resolve({ sessionId: 'session', state: 'user', epoch: 1, controllingViewerId: 'viewer', reason: null })
    await input
    expect(fake.port.input).toHaveBeenCalledWith(expect.objectContaining({ id: 'session' }), expect.objectContaining({ tabId: 'tab' }),
      'viewer', 1, 1, [click], expect.any(AbortSignal))
    await controller.close()
  })

  it('discards opening input if the viewport changes before acknowledged control', async () => {
    const fake = browserPortFake(), pending = deferred<BrowserControl>()
    vi.mocked(fake.port.acquire).mockReturnValue(pending.promise)
    const controller = new BrowserController(fake.port, browserRead(), browserRead().tabs[0]!, 'viewer', vi.fn())
    await controller.start(); fake.observer!.frame(frame())
    const input = controller.send(click)
    fake.observer!.frame({ ...frame('session', 'tab', 1), width: 800 })
    pending.resolve({ sessionId: 'session', state: 'user', epoch: 1, controllingViewerId: 'viewer', reason: null })
    await input
    expect(fake.port.input).not.toHaveBeenCalled()
    expect(controller.getSnapshot().error).toContain('page changed')
    await controller.close()
  })

  it('settles deliberate release before aborting or closing media and never resumes on OS focus loss', async () => {
    const fake = browserPortFake(), pending = deferred<BrowserControl>()
    let mediaSignal!: AbortSignal
    vi.mocked(fake.port.openView).mockImplementation(async (_session, _tab, _viewer, observer, signal) => {
      mediaSignal = signal; observer.frame(frame()); return { close: fake.closeView }
    })
    const controller = new BrowserController(fake.port, browserRead(), browserRead().tabs[0]!, 'viewer', vi.fn())
    await controller.start(); await controller.acquire()
    controller.pause(new Error('window lost focus'))
    expect(fake.port.release).not.toHaveBeenCalled()
    vi.mocked(fake.port.release).mockReturnValue(pending.promise)
    const closing = controller.close()
    expect(mediaSignal.aborted).toBe(false)
    expect(fake.closeView).not.toHaveBeenCalled()
    pending.resolve({ sessionId: 'session', state: 'agent', epoch: 2, controllingViewerId: null, reason: null })
    await closing
    expect(mediaSignal.aborted).toBe(true)
    expect(fake.closeView).toHaveBeenCalledTimes(1)
  })

  it('keeps input sequence monotonic when the same viewer switches owned tabs without releasing its epoch', async () => {
    const initial = browserRead(), fake = browserPortFake(initial)
    const first = new BrowserController(fake.port, initial, initial.tabs[0]!, 'viewer-sequence', vi.fn())
    await first.start(); fake.observer!.frame(frame()); await first.send(click)
    const control = first.getSnapshot().control
    await first.close(false)
    const other = { ...initial.tabs[0]!, tabId: 'second', id: 'second-lease' }
    const next = new BrowserController(fake.port, { ...initial, control }, other, 'viewer-sequence', vi.fn())
    vi.mocked(fake.port.acquire).mockResolvedValue(control)
    await next.start(); fake.observer!.frame(frame('session', 'second')); await next.send(click)
    expect(vi.mocked(fake.port.input).mock.calls.map(call => call[4])).toEqual([1, 2])
    await next.close()
  })

  it('rejects stale/foreign frames and permanently clears protected images after denied access', async () => {
    const fake = browserPortFake(), denied = vi.fn()
    const controller = new BrowserController(fake.port, browserRead(), browserRead().tabs[0]!, 'viewer', denied)
    await controller.start(); fake.observer!.frame(frame())
    fake.observer!.frame(frame('another-session', 'tab', 4))
    expect(controller.getSnapshot().frame?.sessionId).toBe('session')
    fake.observer!.disconnected(Object.assign(new Error('denied'), { status: 403 }))
    expect(controller.getSnapshot().frame).toBeNull()
    expect(denied).toHaveBeenCalledTimes(1)
    fake.observer!.frame(frame('session', 'tab', 5))
    expect(controller.getSnapshot().frame).toBeNull()
    await controller.close(false)
  })

  it('releases late takeover after the selected view retires without forwarding its buffered input', async () => {
    const fake = browserPortFake(), pending = deferred<BrowserControl>()
    vi.mocked(fake.port.acquire).mockReturnValue(pending.promise)
    const controller = new BrowserController(fake.port, browserRead(), browserRead().tabs[0]!, 'viewer', vi.fn())
    await controller.start(); fake.observer!.frame(frame())
    const input = controller.send(click), closing = controller.close()
    pending.resolve({ sessionId: 'session', state: 'user', epoch: 1, controllingViewerId: 'viewer', reason: null })
    await Promise.all([input, closing])
    expect(fake.port.input).not.toHaveBeenCalled()
    expect(fake.port.release).toHaveBeenCalledTimes(1)
  })
})

it('latches two separate focus losses until explicit recovery and fences both host epochs', async () => {
  const fake = browserPortFake(), read = browserRead()
  const controller = new BrowserController(fake.port, read, read.tabs[0]!, 'twice', vi.fn())
  await controller.start(); fake.observer!.frame(frame()); await controller.acquire()
  const first = controller.getSnapshot().control
  controller.pause(new Error('Window lost focus'))
  fake.observer!.frame(frame('session', 'tab', 2)); fake.observer!.control(first)
  await controller.send(click)
  expect(controller.getSnapshot()).toMatchObject({ notice: 'paused', stale: true, pendingInputs: 0 })
  expect(fake.port.input).not.toHaveBeenCalled()
  await controller.release()
  fake.observer!.frame(frame('session', 'tab', 3)); await controller.acquire()
  const second = controller.getSnapshot().control
  controller.pause(new Error('Window lost focus again'))
  fake.observer!.frame(frame('session', 'tab', 4)); fake.observer!.control(second)
  await controller.send(click)
  expect(fake.port.pause).toHaveBeenCalledTimes(2)
  expect(vi.mocked(fake.port.pause).mock.calls[0]![3]).not.toBe(vi.mocked(fake.port.pause).mock.calls[1]![3])
  expect(vi.mocked(fake.port.pause).mock.calls[1]![2]).toBeGreaterThan(vi.mocked(fake.port.pause).mock.calls[0]![2])
  expect(controller.getSnapshot()).toMatchObject({ notice: 'paused', stale: true })
  expect(fake.port.input).not.toHaveBeenCalled()
  await controller.close()
})
