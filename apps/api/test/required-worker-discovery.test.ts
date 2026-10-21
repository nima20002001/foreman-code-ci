import { afterEach, expect, it, vi } from 'vitest'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'
import { HarnessInstallationMonitor } from '../src/modules/harnesses/installationMonitor.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { SOURCE_LIMITS } from '../src/modules/sources/manifest.js'
import { startSqlFixture } from './eng04-start-fixtures.js'

afterEach(() => vi.useRealTimers())

it.each(['http', 'mcp'] as const)(
  '%s refuses Start when its shared Worker discovery expires before the preparation deadline', async source => {
    vi.useFakeTimers()
    const host = { kind: 'device' as const, mainId: 'fixture-main', deviceId: 'fixture-worker' }
    let failDiscovery!: (error: Error) => void
    const discovery = new Promise<never>((_resolve, reject) => { failDiscovery = reject })
    const request = vi.fn().mockReturnValueOnce(discovery).mockResolvedValue({ payload: {} })
    const collectWorker = vi.fn(async () => {})
    const report = vi.fn()
    const monitor = new HarnessInstallationMonitor({
      installations: { list: () => [{ hostRef: host }] },
      observeInstallations: () => {},
    } as never, {} as never, () => ({ captureRequest: () => ({ binding: {}, request }) }) as never,
    collectWorker, async () => {}, report)
    const background = monitor.refresh()
    const f = startSqlFixture()
    let entered!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const publication = { ...f.publication, placementAdmission: {
      prepare: async (_input: unknown, _principal: unknown, signal?: AbortSignal,
        options?: { sourcePreparationStarted?: () => void }) => {
        options!.sourcePreparationStarted!()
        const refreshing = monitor.refreshHosts([host], signal)
        entered()
        await refreshing
        return undefined
      },
    } }
    try {
      // Start can join an older background request just before that request's own deadline.
      await vi.advanceTimersByTimeAsync(29_999)
      const start = admitRepeatRun(f.pool, f.locations, f.principal, source, f.request, publication)
        .then(value => ({ value }), (error: unknown) => ({ error }))
      await preparing
      const failure = new DeviceApplicationError('timeout')
      failDiscovery(failure)
      await background
      expect(await start).toMatchObject({ error: { code: 'HARNESS_INVENTORY_UNAVAILABLE' } })
      expect(f.database().run).toBeUndefined()
      expect(f.state.publications).toBe(0)
      expect(f.state.filesystemCalls).toBe(0)
      expect(report).toHaveBeenCalledWith(failure)
      expect(collectWorker).not.toHaveBeenCalled()
      expect(request).toHaveBeenCalledOnce()

      const started = await admitRepeatRun(f.pool, f.locations, f.principal, source, f.request, publication)
      expect(f.database().run).toEqual(started.value)
      expect(f.state.publications).toBe(1)
      expect(collectWorker).toHaveBeenCalledOnce()
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      failDiscovery(new Error('Fixture closing'))
      await background
      await monitor.close()
    }
  },
)

it('refreshes required discovery during backoff without accelerating background retries', async () => {
  vi.useFakeTimers()
  const host = { kind: 'device' as const, mainId: 'fixture-main', deviceId: 'fixture-worker' }
  const failure = new DeviceApplicationAdmissionError()
  const request = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ payload: {} })
  const collectWorker = vi.fn(async () => {})
  const monitor = new HarnessInstallationMonitor({
    installations: { list: () => [{ hostRef: host }] },
    observeInstallations: () => {},
  } as never, {} as never, () => ({ captureRequest: () => ({ binding: {}, request }) }) as never,
  collectWorker, async () => {}, vi.fn())
  try {
    await monitor.refresh()
    const result = await monitor.refreshHosts([host], new AbortController().signal)
      .then(() => ({ refreshed: true }), (error: unknown) => ({ error }))
    expect(result).toEqual({ refreshed: true })
    expect(collectWorker).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]![1]).toMatchObject({ priority: 'foreground' })
    await monitor.refresh()
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    await monitor.refresh()
    expect(collectWorker).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[2]![1]).toMatchObject({ priority: 'background' })
  } finally {
    await monitor.close()
  }
})

it('times out Start without canceling shared discovery or admitting a late Run', async () => {
  vi.useFakeTimers()
  const host = { kind: 'device' as const, mainId: 'fixture-main', deviceId: 'fixture-worker' }
  let release!: () => void
  const discovery = new Promise<void>(resolve => { release = resolve })
  let discoverySignal: AbortSignal | undefined
  const request = vi.fn(async (_payload: unknown, options: { signal: AbortSignal }) => {
    discoverySignal = options.signal
    await discovery
    return { payload: {} }
  })
  const collectWorker = vi.fn(async () => {})
  const monitor = new HarnessInstallationMonitor({
    installations: { list: () => [{ hostRef: host }] },
    observeInstallations: () => {},
  } as never, {} as never, () => ({ captureRequest: () => ({ binding: {}, request }) }) as never,
  collectWorker, async () => {}, vi.fn())
  const background = monitor.refresh()
  const f = startSqlFixture()
  let entered!: () => void
  const preparing = new Promise<void>(resolve => { entered = resolve })
  const start = admitRepeatRun(f.pool, f.locations, f.principal, 'mcp', f.request, {
    ...f.publication, placementAdmission: {
      prepare: async (_input, _principal, signal, options) => {
        options!.sourcePreparationStarted!()
        const refreshing = monitor.refreshHosts([host], signal)
        entered()
        await refreshing
        return undefined
      },
    },
  })
  const rejected = expect(start).rejects.toMatchObject({ code: 'RUN_START_PREPARATION_TIMEOUT' })
  try {
    await preparing
    await vi.advanceTimersByTimeAsync(SOURCE_LIMITS.preparationMs)
    await rejected
    expect(discoverySignal!.aborted).toBe(false)
    expect(collectWorker).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
    release()
    await background
    expect(collectWorker).toHaveBeenCalledOnce()
    expect(f.database().run).toBeUndefined()
    expect(f.state.publications).toBe(0)
    expect(f.state.filesystemCalls).toBe(0)
  } finally {
    release()
    await background
    await monitor.close()
  }
})
