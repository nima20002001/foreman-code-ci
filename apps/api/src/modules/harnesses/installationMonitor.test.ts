import { expect, it, vi } from 'vitest'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { HarnessInstallationMonitor } from './installationMonitor.js'
import type { AutomaticHostProfileCheck } from './instanceSettings/profileChecks.js'
import { DomainError } from '../errors.js'
import { DeviceApplicationAdmissionError, DeviceApplicationError, deviceApplicationFailure } from '../devices/deviceApplicationError.js'
import { qualificationError } from './qualificationErrors.js'

it.each(['HARNESS_INVENTORY_STALE', 'HARNESS_QUALIFICATION_TARGET_CHANGED'])(
  'preserves the retryable Worker qualification failure %s across the application channel', code => {
    expect(deviceApplicationFailure(new DomainError(code, 'Installation changed.', 409)))
      .toEqual({ code, class: 'transient', retryable: true })
  },
)

it.each([
  [new DomainError('HARNESS_INVENTORY_STALE', 'Installation changed.', 409), 3],
  [new DeviceApplicationError('HARNESS_QUALIFICATION_TARGET_CHANGED'), 3],
  [new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'Installation unavailable.', 409), 2],
  [new DomainError('HARNESS_QUALIFICATION_FAILED', 'Qualification failed.', 503), 2],
] as const)('retries only stale payload checks on the next refresh (%s)', async (failure, expectedChecks) => {
  const hostRef = { kind: 'main' as const, mainId: 'main' }
  let fingerprint = 'original-payload'
  let listener: ((host: CanonicalMachineReference, installationId: string) => void) | undefined
  const recheckInstallation = vi.fn<(input: AutomaticHostProfileCheck) => Promise<void>>(async () => {})
  const registry = {
    observeInstallations: (value: typeof listener) => { listener = value },
    installations: { list: () => [{ hostRef, harnessInstallationId: 'launcher',
      installationFingerprint: fingerprint, driverId: 'codex', driverRevision: '1',
      protocolRevision: 'protocol', environmentGeneration: 'environment', connectionGeneration: 'connection',
      installed: true }] },
    refreshMain: async () => { listener?.(hostRef, 'main') },
  }
  let reported!: () => void
  const failed = new Promise<void>(resolve => { reported = resolve })
  const report = vi.fn(() => { reported() })
  const monitor = new HarnessInstallationMonitor(registry as never, { recheckInstallation } as never,
    () => ({} as never), async () => {}, async () => {}, report)
  try {
    monitor.start('main')
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    recheckInstallation.mockRejectedValueOnce(new AggregateError([failure], 'Automatic check failed.'))
    fingerprint = 'updated-payload'
    await monitor.refresh()
    await failed
    expect(recheckInstallation).toHaveBeenCalledTimes(2)
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(expectedChecks)
    if (expectedChecks === 3) {
      expect(recheckInstallation.mock.calls[2]![0].generation)
        .toBe(recheckInstallation.mock.calls[1]![0].generation)
    }
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(expectedChecks)
    expect(report).toHaveBeenCalledOnce()
  } finally { await monitor.close() }
})

it('lets a stale automatic Worker check refresh the inventory with foreground discovery', async () => {
  const hostRef = { kind: 'device' as const, mainId: 'main', deviceId: 'worker' }
  let busy = false
  let listener: ((host: CanonicalMachineReference, installationId: string) => void) | undefined
  const recheckInstallation = vi.fn<(input: AutomaticHostProfileCheck) => Promise<void>>(async () => {})
  const registry = {
    observeInstallations: (value: typeof listener) => { listener = value },
    installations: { list: () => [{ hostRef, harnessInstallationId: 'launcher',
      installationFingerprint: 'payload', driverId: 'codex', driverRevision: '1',
      protocolRevision: 'protocol', environmentGeneration: 'environment', connectionGeneration: 'connection',
      installed: true }] },
    refreshMain: async () => {},
  }
  const binding = { mainId: 'main', deviceId: 'worker', workerInstallationId: 'installation' }
  const discover = vi.fn(async () => ({ payload: { inventory: 'refreshed' } }))
  const collectWorker = vi.fn(async () => { listener?.(hostRef, 'installation') })
  const monitor = new HarnessInstallationMonitor(registry as never, { recheckInstallation } as never,
    () => ({ captureRequest: () => ({ binding, get busy() { return busy }, request: discover }) }) as never,
    collectWorker, async () => {}, vi.fn())
  try {
    monitor.start('main')
    monitor.workerReady(binding as never, new AbortController().signal)
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    const check = recheckInstallation.mock.calls[0]![0]
    // A stale check runs while the Worker is busy with the other profile check.
    busy = true
    await check.refresh!(new AbortController().signal)
    expect(discover).toHaveBeenCalledWith({ operation: 'discover', refreshId: expect.any(String) },
      expect.objectContaining({ priority: 'foreground' }))
    expect(collectWorker).toHaveBeenCalledWith(binding, { inventory: 'refreshed' })
  } finally { await monitor.close() }
})

it('detects a new payload at the same launcher and schedules one automatic check per inventory generation', async () => {
  const hostRef = { kind: 'main' as const, mainId: 'main' }
  let fingerprint = 'old-payload'
  let listener: ((host: CanonicalMachineReference, installationId: string) => void) | undefined
  const recheckInstallation = vi.fn<(input: AutomaticHostProfileCheck) => Promise<void>>(async () => {})
  const registry = {
    observeInstallations: (value: typeof listener) => { listener = value },
    installations: { list: () => [{ hostRef, harnessInstallationId: 'same-launcher',
      installationFingerprint: fingerprint, driverId: 'codex', driverRevision: '1',
      protocolRevision: 'protocol', environmentGeneration: 'environment', connectionGeneration: 'connection', installed: true }] },
    refreshMain: async () => { listener?.(hostRef, 'main') },
  }
  const report = vi.fn()
  const monitor = new HarnessInstallationMonitor(registry as never, { recheckInstallation } as never,
    () => ({} as never), async () => {}, async () => {}, report, 100)
  vi.useFakeTimers()
  try {
    monitor.start('main')
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    fingerprint = 'updated-payload'
    await vi.advanceTimersByTimeAsync(100)
    expect(recheckInstallation).toHaveBeenCalledTimes(2)
    const first = recheckInstallation.mock.calls[0]![0]
    const updated = recheckInstallation.mock.calls[1]![0]
    expect(updated.generation).not.toBe(first.generation)
    expect(updated.host).toEqual(hostRef)
    expect(updated.driverId).toBe('codex')
    expect(updated.applicationInstallationId).toBe('main')
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(2)
    expect(report).not.toHaveBeenCalled()
  } finally {
    await monitor.close()
    vi.useRealTimers()
  }
  expect(listener).toBeUndefined()
})

it('schedules only the changed driver when Claude updates beside an unchanged Codex installation', async () => {
  const hostRef = { kind: 'main' as const, mainId: 'main' }
  let listener: ((host: CanonicalMachineReference, installationId: string) => void) | undefined
  const fingerprints = { codex: 'codex-original', claude: 'claude-original' }
  const recheckInstallation = vi.fn<(input: AutomaticHostProfileCheck) => Promise<void>>(async () => {})
  const registry = {
    observeInstallations: (value: typeof listener) => { listener = value },
    installations: { list: () => Object.entries(fingerprints).map(([driverId, installationFingerprint]) => ({
      hostRef, driverId, installationFingerprint, harnessInstallationId: driverId, driverRevision: '1',
      protocolRevision: 'protocol', environmentGeneration: 'environment', connectionGeneration: 'connection',
      installed: true,
    })) },
    refreshMain: async () => { listener?.(hostRef, 'main') },
  }
  const monitor = new HarnessInstallationMonitor(registry as never, { recheckInstallation } as never,
    () => ({} as never), async () => {}, async () => {}, vi.fn())
  try {
    monitor.start('main')
    expect(recheckInstallation.mock.calls.map(([input]) => input.driverId)).toEqual(['codex', 'claude'])
    recheckInstallation.mockClear()
    fingerprints.claude = 'claude-updated'
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    expect(recheckInstallation.mock.calls[0]![0]).toMatchObject({ driverId: 'claude' })
    expect(recheckInstallation.mock.calls[0]![0].beforeChecks).toBeUndefined()
  } finally { await monitor.close() }
})

it('refreshes Main independently of a slow unused Worker and cancels only a required-host caller wait', async () => {
  const main = { kind: 'main' as const, mainId: 'main' }
  const worker = { kind: 'device' as const, mainId: 'main', deviceId: 'worker' }
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const discovering = new Promise<void>(resolve => { entered = resolve })
  let discoverySignal: AbortSignal | undefined
  const request = vi.fn(async (_input: unknown, options: { signal: AbortSignal }) => {
    discoverySignal = options.signal
    entered()
    await waiting
    return { payload: { discovered: true } }
  })
  const refreshMain = vi.fn(async () => {})
  const collectWorker = vi.fn(async () => {})
  const registry = { installations: { list: () => [{ hostRef: main }, { hostRef: worker }] },
    refreshMain, observeInstallations: () => {} }
  const monitor = new HarnessInstallationMonitor(registry as never, {} as never,
    () => ({ captureRequest: () => ({ binding: {}, request }) }) as never,
    collectWorker, async () => {}, vi.fn())
  const background = monitor.refresh()
  try {
    await discovering
    await monitor.refreshHosts([main])
    expect(refreshMain).toHaveBeenCalled()
    expect(collectWorker).not.toHaveBeenCalled()
    const canceled = new AbortController()
    const start = monitor.refreshHosts([worker], canceled.signal)
    const failure = new Error('Start canceled')
    canceled.abort(failure)
    await expect(start).rejects.toBe(failure)
    expect(discoverySignal!.aborted).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
    release()
    await background
    expect(collectWorker).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await background
    await monitor.close()
  }
})

it('backs off pressured discovery exponentially, skips busy devices, and resumes after success', async () => {
  vi.useFakeTimers()
  const hostRef = { kind: 'device' as const, mainId: 'main', deviceId: 'worker' }
  let busy = false
  const request = vi.fn().mockRejectedValue(new DeviceApplicationAdmissionError())
  const collectWorker = vi.fn().mockResolvedValue(undefined)
  const report = vi.fn()
  const registry = { installations: { list: () => [{ hostRef }] }, observeInstallations: () => {} }
  const monitor = new HarnessInstallationMonitor(registry as never, {} as never,
    () => ({ captureRequest: () => ({ binding: {}, request, get busy() { return busy } }) }) as never,
    collectWorker, async () => {}, report)
  try {
    await monitor.refresh()
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await monitor.refresh()
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await monitor.refresh()
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    await monitor.refresh()
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    busy = true
    await monitor.refresh()
    expect(request).toHaveBeenCalledTimes(2)
    busy = false
    request.mockResolvedValue({ payload: { discovered: true } })
    await monitor.refresh()
    await monitor.refresh()
    expect(request).toHaveBeenCalledTimes(4)
    expect(collectWorker).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(2)
  } finally {
    await monitor.close()
    vi.useRealTimers()
  }
})

it('defers automatic qualification while busy and retries its unchanged generation after pressure', async () => {
  vi.useFakeTimers()
  const hostRef = { kind: 'device' as const, mainId: 'main', deviceId: 'worker' }
  let busy = true
  let listener: ((host: CanonicalMachineReference, installationId: string) => void) | undefined
  const recheckInstallation = vi.fn().mockRejectedValueOnce(
    new AggregateError([qualificationError(new DeviceApplicationAdmissionError())], 'Automatic check failed.'))
    .mockResolvedValue(undefined)
  const registry = {
    observeInstallations: (value: typeof listener) => { listener = value },
    installations: { list: () => [{ hostRef, harnessInstallationId: 'launcher',
      installationFingerprint: 'payload', driverId: 'codex', driverRevision: '1',
      protocolRevision: 'protocol', environmentGeneration: 'environment', connectionGeneration: 'connection',
      installed: true }] },
    refreshMain: async () => {},
  }
  const monitor = new HarnessInstallationMonitor(registry as never, { recheckInstallation } as never,
    () => ({ captureRequest: () => ({ binding: {}, get busy() { return busy },
      request: async () => ({ payload: {} }) }) }) as never,
    async () => { listener?.(hostRef, 'installation') }, async () => {}, vi.fn())
  try {
    monitor.start('main')
    monitor.workerReady({ mainId: 'main', deviceId: 'worker', workerInstallationId: 'installation' } as never,
      new AbortController().signal)
    expect(recheckInstallation).not.toHaveBeenCalled()
    busy = false
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(2)
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(2)
  } finally {
    await monitor.close()
    vi.useRealTimers()
  }
})


it('retries discovery for a connected Worker whose first inventory was unavailable', async () => {
  const binding = { mainId: 'main', deviceId: 'worker', workerInstallationId: 'installation' }
  const workerLifetime = new AbortController()
  const request = vi.fn(async () => ({ payload: { installations: [] } }))
  const collect = vi.fn(async () => {})
  const registry = { observeInstallations: () => {}, installations: { list: () => [] }, refreshMain: async () => {} }
  const endpoint = { captureRequest: () => ({ binding, request }) }
  const monitor = new HarnessInstallationMonitor(registry as never,
    { recheckInstallation: async () => {} } as never, () => endpoint as never,
    collect, async () => {}, vi.fn())
  try {
    monitor.start('main')
    monitor.workerReady(binding as never, workerLifetime.signal)
    await monitor.refresh()
    expect(request).toHaveBeenCalledOnce()
    expect(collect).toHaveBeenCalledWith(binding, { installations: [] })
    workerLifetime.abort()
    await monitor.refresh()
    expect(request).toHaveBeenCalledOnce()
  } finally { await monitor.close() }
})


it('refreshes a required host with foreground admission while background discovery is backing off', async () => {
  const hostRef = { kind: 'device' as const, mainId: 'main', deviceId: 'worker' }
  const request = vi.fn().mockRejectedValueOnce(new DeviceApplicationAdmissionError())
    .mockResolvedValue({ payload: { installations: [] } })
  const collected: unknown[] = []
  const registry = { installations: { list: () => [{ hostRef }] }, observeInstallations: () => {} }
  const monitor = new HarnessInstallationMonitor(registry as never, {} as never,
    () => ({ captureRequest: () => ({ binding: {}, request, busy: false }) }) as never,
    async (_binding, inventory) => { collected.push(inventory) }, async () => {}, vi.fn())
  try {
    await monitor.refresh()
    await monitor.refresh()
    expect(request).toHaveBeenCalledTimes(1)
    await expect(monitor.refreshHosts([hostRef])).resolves.toBeUndefined()
    expect(collected).toEqual([{ installations: [] }])
    expect(request.mock.calls[1]![1]).toMatchObject({ priority: 'foreground' })
    await monitor.refresh()
    expect(request).toHaveBeenCalledTimes(2)
  } finally { await monitor.close() }
})


it.each([new DeviceApplicationError('timeout'), new DeviceApplicationAdmissionError()])(
  'does not retry failed shared discovery after a required-host caller cancels its wait (%s)', async failure => {
  const hostRef = { kind: 'device' as const, mainId: 'main', deviceId: 'worker' }
  let failDiscovery!: (error: Error) => void
  const discovery = new Promise<never>((_resolve, reject) => { failDiscovery = reject })
  const request = vi.fn().mockReturnValueOnce(discovery).mockResolvedValue({ payload: {} })
  const collectWorker = vi.fn(async () => {})
  const registry = { installations: { list: () => [{ hostRef }] }, observeInstallations: () => {} }
  const monitor = new HarnessInstallationMonitor(registry as never, {} as never,
    () => ({ captureRequest: () => ({ binding: {}, request }) }) as never,
    collectWorker, async () => {}, vi.fn())
  const background = monitor.refresh()
  const controller = new AbortController()
  const waiting = monitor.refreshHosts([hostRef], controller.signal)
    .then(() => ({ refreshed: true }), (error: unknown) => ({ error }))
  try {
    const canceled = new Error('Start preparation canceled')
    controller.abort(canceled)
    expect(await waiting).toEqual({ error: canceled })
    failDiscovery(failure)
    await background
    expect(request).toHaveBeenCalledOnce()
    expect(collectWorker).not.toHaveBeenCalled()
  } finally {
    failDiscovery(new Error('Fixture closing'))
    await background
    await monitor.close()
  }
})


it.each([
  { failure: new DeviceApplicationAdmissionError(), retries: true },
  { failure: new DeviceApplicationError('timeout'), retries: false },
  { failure: undefined, retries: false },
])('shares discovery and retries only background capacity refusals for live foreground waiters ($failure)',
  async ({ failure, retries }) => {
    const hostRef = { kind: 'device' as const, mainId: 'main', deviceId: 'worker' }
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const request = vi.fn().mockImplementationOnce(async () => {
      await waiting
      if (failure) throw failure
      return { payload: { installations: [] } }
    }).mockResolvedValue({ payload: { installations: [] } })
    const collectWorker = vi.fn(async () => {})
    const registry = { installations: { list: () => [{ hostRef }] }, observeInstallations: () => {} }
    const monitor = new HarnessInstallationMonitor(registry as never, {} as never,
      () => ({ captureRequest: () => ({ binding: {}, request }) }) as never,
      collectWorker, async () => {}, vi.fn())
    const background = monitor.refresh()
    const starts = Promise.allSettled([monitor.refreshHosts([hostRef]), monitor.refreshHosts([hostRef])])
    try {
      expect(request).toHaveBeenCalledOnce()
      release()
      await background
      const results = await starts
      expect(results.map(result => result.status)).toEqual(failure && !retries
        ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled'])
      expect(request).toHaveBeenCalledTimes(retries ? 2 : 1)
      expect(request.mock.calls[0]![1]).toMatchObject({ priority: 'background' })
      if (retries) expect(request.mock.calls[1]![1]).toMatchObject({ priority: 'foreground' })
      expect(collectWorker).toHaveBeenCalledTimes(failure && !retries ? 0 : 1)
      if (retries) {
        await monitor.refresh()
        expect(request).toHaveBeenCalledTimes(2)
      }
    } finally {
      release()
      await background
      await starts
      await monitor.close()
    }
  })
