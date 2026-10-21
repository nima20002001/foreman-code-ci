import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { TELEMETRY_LIMITS, type CollectionChallenge, type TelemetryCollectedBatch, type TelemetryIdentity } from '@foreman-code/contracts/resource-telemetry'
import { createMainResourceTelemetryBindings, createWorkerResourceTelemetryExtension, mainResourceTelemetryExtension, remoteTelemetryContext, startRemoteTelemetrySession } from './carrier.js'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import { ResourceTelemetryService } from './service.js'
import { DeviceApplicationChannel, extensionDescriptors } from '../../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../../devices/deviceWire.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { DomainError } from '../../errors.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) { queueMicrotask(() => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false) }) }
  close() { if (this.closed) return; this.closed = true; this.emit('close'); this.peer?.close() }
}

const binding: DeviceSessionBinding = { mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
  workerInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1,
  authorizationRevision: 1, bootId: '44444444-4444-4444-8444-444444444444', connectionEpoch: '55555555-5555-4555-8555-555555555555', connectionGeneration: 1 }
function batch(c: CollectionChallenge): TelemetryCollectedBatch {
  return { schemaVersion: 1, identity: c.identity, challengeId: c.challengeId, sequence: '1', collectedAtUnixMs: 1000,
    challengeReceivedMonoNs: '1', captureStartMonoNs: '2', captureEndMonoNs: '3', logicalCpuCount: 1,
    host: { selector: { schemaVersion: 1, scope: 'computer', mainId: c.identity.mainId, host: c.identity.host },
      coverage: { boundary: 'complete-boundary', shared: false, reasons: [] }, cpu: { state: 'warmup', reason: 'warmup' },
      memory: { state: 'ok', value: { kind: 'host-used-estimate', bytes: 0, totalBytes: 1, availableBytes: 1, sharedPagesMayDoubleCount: false } } },
    owned: [], diagnostics: [], truncated: false }
}
function setup(options: { delayFirstSample?: boolean; bindingReaderThrows?: boolean; collectorError?: Error } = {}) {
  const lifetime = new AbortController()
  let current: DeviceSessionBinding | null = binding, authorized = true
  const service = new ResourceTelemetryService({ clock: { monotonicMs: () => Date.now(), unixMs: () => Date.now() },
    sessions: { active: async () => authorized, presence: async () => 'online' },
    reads: { allow: async () => true, allowSharedOwner: async () => true }, ownership: { resolve: async () => null } })
  const collectors: { signal: AbortSignal; close: ReturnType<typeof vi.fn>;
    offered: CollectionChallenge | undefined; push(value: TelemetryCollectedBatch): void }[] = []
  const createCollector = vi.fn(async (_identity: TelemetryIdentity, signal: AbortSignal) => {
    let pending: TelemetryCollectedBatch | undefined, stopped = false, wake: (() => void) | undefined
    const close = vi.fn(async () => { stopped = true; wake?.() })
    const delayed = options.delayFirstSample && collectors.length === 0
    let sequence = 0
    const collector = { signal, close, offered: undefined as CollectionChallenge | undefined,
      push(value: TelemetryCollectedBatch) { pending = value; wake?.() } }
    collectors.push(collector)
    return { offer(c: CollectionChallenge) {
      collector.offered = c
      if (!delayed) collector.push({ ...batch(c), sequence: String(++sequence) })
      return 'accepted' as const
    },
      async *samples() { while (!stopped && !signal.aborted) {
        if (!pending) await new Promise<void>(resolve => { wake = resolve })
        if (pending) {
          if (options.collectorError) throw options.collectorError
          const value = pending
          pending = undefined
          yield value
        }
      } }, close }
  })
  const worker = createWorkerResourceTelemetryExtension({ signal: lifetime.signal, currentBinding: () => {
    if (!current && options.bindingReaderThrows) {
      throw new DomainError('WORKER_DOMAIN_UNAVAILABLE', 'The paired Main connection is unavailable.', 409)
    }
    return current
  }, createCollector })
  const request = vi.fn(async (payload: unknown, options: { signal?: AbortSignal }) => worker.extension.handle!(payload,
    { binding, signal: options.signal ?? lifetime.signal }))
  const challenge = async () => {
    const context = remoteTelemetryContext(binding)
    await service.handshake(context, 'collector', lifetime.signal)
    return (await service.challenge(context, lifetime.signal))!
  }
  return { lifetime, service, worker, request, challenge, createCollector, collectors,
    revoke() { authorized = false }, change(value: DeviceSessionBinding | null) { current = value } }
}
afterEach(() => vi.useRealTimers())
it('retries a transient attachment lookup at the collection interval without reconnecting', async () => {
  vi.useFakeTimers()
  const s = setup()
  const original = s.service.ports.sessions.active
  const active = vi.spyOn(s.service.ports.sessions, 'active')
    .mockRejectedValueOnce(Object.assign(new Error('statement timeout'), { code: '57014' }))
    .mockImplementation(original)
  const starting = startRemoteTelemetrySession({ service: s.service, binding,
    signal: s.lifetime.signal, request: s.request })
  const outcome = starting.then(session => ({ session, error: undefined }),
    (error: unknown) => ({ session: undefined, error }))
  try {
    await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.intervalMs - 1)
    expect(active).toHaveBeenCalledTimes(1)
    expect(s.request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const result = await outcome
    expect(result.error).toBeUndefined()
    expect(s.request).toHaveBeenCalledTimes(1)
    expect(await s.service.availableComputerMemory({
      hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      applicationInstallationId: binding.workerInstallationId, bootId: binding.bootId,
      keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision,
    }, s.lifetime.signal)).toBe(1)
  } finally {
    s.lifetime.abort()
    await (await outcome).session?.close()
    await s.worker.close()
    await s.service.close()
  }
})

it('stops attachment retries when the connection lifetime ends', async () => {
  vi.useFakeTimers()
  const s = setup()
  const active = vi.spyOn(s.service.ports.sessions, 'active')
    .mockRejectedValue(Object.assign(new Error('statement timeout'), { code: '57014' }))
  const starting = startRemoteTelemetrySession({ service: s.service, binding,
    signal: s.lifetime.signal, request: s.request })
  const outcome = starting.then(() => undefined, (error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  s.lifetime.abort(new Error('connection closed'))
  try {
    expect(await outcome).toEqual(new Error('connection closed'))
    await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.intervalMs)
    expect(active).toHaveBeenCalledTimes(1)
    expect(s.request).not.toHaveBeenCalled()
  } finally {
    await s.worker.close()
    await s.service.close()
  }
})

it('keeps attachment authorization denials terminal', async () => {
  vi.useFakeTimers()
  const s = setup()
  s.revoke()
  const active = vi.spyOn(s.service.ports.sessions, 'active')
  try {
    await expect(startRemoteTelemetrySession({ service: s.service, binding,
      signal: s.lifetime.signal, request: s.request })).rejects.toThrow('authorization')
    await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.intervalMs)
    expect(active).toHaveBeenCalledTimes(1)
    expect(s.request).not.toHaveBeenCalled()
  } finally {
    s.lifetime.abort()
    await s.worker.close()
    await s.service.close()
  }
})

describe('authenticated W07 passive telemetry carrier', () => {
  it.each([false, true])('keeps collecting after a retired binding delivers a late sample (reader throws: %s)', async bindingReaderThrows => {
    vi.useFakeTimers()
    const s = setup({ delayFirstSample: true, bindingReaderThrows })
    const requestLifetime = new AbortController()
    const challenge = await s.challenge()
    const oldRequest = s.request({ operation: 'collect', challenge }, { signal: requestLifetime.signal })
    const cancelled = expect(oldRequest).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(s.collectors[0]?.offered).toBeDefined())
    s.change(null)
    requestLifetime.abort()
    await cancelled
    s.collectors[0]!.push(batch(challenge))
    await vi.waitFor(() => expect(s.collectors[0]!.signal.aborted).toBe(true))
    const replacement = { ...binding, connectionEpoch: randomUUID(), connectionGeneration: 2 }
    s.change(replacement)
    const request = vi.fn((payload: unknown, options: { signal?: AbortSignal }) => s.worker.extension.handle!(payload,
      { binding: replacement, signal: options.signal ?? s.lifetime.signal }))
    const session = await startRemoteTelemetrySession({ service: s.service, binding: replacement,
      signal: s.lifetime.signal, request })
    try {
      await vi.waitFor(() => expect(s.collectors).toHaveLength(2))
      const expected = { hostRef: { kind: 'device' as const, mainId: binding.mainId,
        deviceId: binding.deviceId }, applicationInstallationId: binding.workerInstallationId,
        bootId: binding.bootId, keyRevision: 1, authorizationRevision: 1 }
      await vi.waitFor(async () => expect(await s.service.availableComputerMemory(expected, s.lifetime.signal)).toBe(1))
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2), { timeout: 4000 })
      expect(s.collectors[0]!.close).toHaveBeenCalledTimes(1)
      expect(await s.service.availableComputerMemory(expected, s.lifetime.signal)).toBe(1)
    } finally {
      s.lifetime.abort()
      await session.close()
      await s.worker.close()
      await s.service.close()
    }
  })
  it('reports unexpected collector failures to the session owner and joins the failed pump', async () => {
    const s = setup({ collectorError: new Error('Collector capture failed') })
    const session = await startRemoteTelemetrySession({ service: s.service, binding,
      signal: s.lifetime.signal, request: s.request })
    await expect(session.completion).rejects.toThrow('Collector capture failed')
    s.lifetime.abort()
    await session.close()
    await expect(s.worker.close()).rejects.toThrow('Collector capture failed')
    expect(s.collectors[0]!.close).toHaveBeenCalledOnce()
    await s.service.close()
  })
  it('starts fresh computer memory on the synchronized Main binding and joins it on loss', async () => {
    const s = setup()
    const mounted = createMainResourceTelemetryBindings(() => s.service)
    const endpoint = { captureRequest: () => ({ binding, request: s.request }) } as unknown as DeviceEndpoint
    try {
      expect(await mounted.ready({ ...binding, connectionEpoch: randomUUID() }, s.lifetime.signal, endpoint)).toBeUndefined()
      const session = await mounted.ready(binding, s.lifetime.signal, endpoint)
      expect(session).toBeDefined()
      const expected = { hostRef: { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId },
        applicationInstallationId: binding.workerInstallationId, bootId: binding.bootId,
        keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision }
      await vi.waitFor(async () => expect(await s.service.availableComputerMemory(expected, s.lifetime.signal)).toBe(1))
      s.revoke()
      expect(await s.service.availableComputerMemory(expected, s.lifetime.signal)).toBeNull()
      await mounted.lost(binding)
      await session!.completion
    } finally {
      s.lifetime.abort()
      await mounted.lost(binding)
      await s.worker.close()
      await s.service.close()
    }
  })
  it('carries bounded challenge samples over negotiated W07 chunks with current authorization rechecks', async () => {
    const s = setup(), mainRaw = new Socket(), workerRaw = new Socket()
    mainRaw.peer = workerRaw; workerRaw.peer = mainRaw
    const mainSocket = adaptDeviceSocket(mainRaw), workerSocket = adaptDeviceSocket(workerRaw)
    const extensions = negotiateDeviceExtensions(extensionDescriptors([mainResourceTelemetryExtension]), extensionDescriptors([s.worker.extension]))
    expect(extensions[0]).toMatchObject({ mainCanRequest: true, workerCanRequest: false, maxJsonBytes: 65536, maxBinaryBytes: 0 })
    let granted = true
    const revalidate = vi.fn(async () => { if (!granted) throw new Error('permission') })
    const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket, signal: s.lifetime.signal,
      extensions, registrations: [mainResourceTelemetryExtension], revalidate })
    const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket, signal: s.lifetime.signal,
      extensions, registrations: [s.worker.extension] })
    const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 10000), worker.run(workerSocket.messages[Symbol.asyncIterator](), 5000)]
    for (const task of tasks) void task.catch(() => { /* ignore: closing the test channels ends both run loops. */ })
    try {
      const c = await s.challenge(), response = await main.request('resource-telemetry', { operation: 'collect', challenge: c })
      expect(response.payload).toEqual(batch(c))
      await expect(s.service.ingest(remoteTelemetryContext(binding), JSON.stringify(response.payload), s.lifetime.signal)).resolves.toMatchObject({ status: 'accepted' })
      expect(revalidate).toHaveBeenCalled()
      granted = false
      // Channels reuse a successful authorization for two minutes; the next request after that rechecks it.
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120_000)
      try {
        await expect(main.request('resource-telemetry', { operation: 'collect', challenge: c })).rejects.toThrow('permission')
      } finally { clock.mockRestore() }
      expect(s.createCollector).toHaveBeenCalledTimes(1)
    } finally {
      s.lifetime.abort(); main.close(); worker.close(); await Promise.allSettled(tasks)
      await s.worker.close(); await main.join(); await worker.join(); await s.service.close()
    }
  })
  it('collects on the existing request channel and preserves the exact remote host identity', async () => {
    vi.useFakeTimers(); const s = setup()
    const session = await startRemoteTelemetrySession({ service: s.service, binding, signal: s.lifetime.signal, request: s.request })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.request).toHaveBeenCalledTimes(1)
    const c = s.request.mock.calls[0]![0] as { challenge: CollectionChallenge }
    expect(c.challenge.identity.host).toMatchObject({ hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId }, applicationInstallationId: binding.workerInstallationId })
    await vi.advanceTimersByTimeAsync(1999); expect(s.request).toHaveBeenCalledTimes(1)
    s.lifetime.abort(); await session.close(); await s.worker.close(); await s.service.close()
    expect(s.collectors[0]!.close).toHaveBeenCalledTimes(1)
  })
  it.each(['challenge', 'ingest'] as const)('recovers from a transient database timeout during %s with a fresh sample', async phase => {
    vi.useFakeTimers()
    const s = setup()
    const original = s.service.ports.sessions.active
    const active = vi.spyOn(s.service.ports.sessions, 'active')
    let calls = 0
    active.mockImplementation(async (...args) => {
      calls++
      // Handshake, challenge authorization, then ingestion authorization.
      if (calls === (phase === 'challenge' ? 2 : 3)) {
        throw Object.assign(new Error('statement timeout'), { code: '57014' })
      }
      return original(...args)
    })
    const session = await startRemoteTelemetrySession({ service: s.service, binding,
      signal: s.lifetime.signal, request: s.request })
    const failures: unknown[] = []
    void session.completion.catch(error => { failures.push(error) })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(s.request).toHaveBeenCalledTimes(phase === 'challenge' ? 0 : 1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(s.request).toHaveBeenCalledTimes(phase === 'challenge' ? 1 : 2)
      const challenges = s.request.mock.calls.map(([payload]) => (payload as { challenge: CollectionChallenge }).challenge.challengeId)
      expect(new Set(challenges).size).toBe(challenges.length)
      expect(failures).toEqual([])
      expect(await s.service.availableComputerMemory({
        hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
        applicationInstallationId: binding.workerInstallationId, bootId: binding.bootId,
        keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision,
      }, s.lifetime.signal)).toBe(1)
    } finally {
      s.lifetime.abort()
      await session.close()
      await s.worker.close()
      await s.service.close()
    }
  })
  it('keeps collecting after a busy channel times out one sample', async () => {
    vi.useFakeTimers(); const s = setup()
    const delegate = s.request.getMockImplementation()!
    s.request.mockImplementationOnce(async () => { throw new DeviceApplicationError('timeout') })
    const session = await startRemoteTelemetrySession({ service: s.service, binding, signal: s.lifetime.signal, request: s.request })
    let failed = false
    void session.completion.catch(() => { failed = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.request).toHaveBeenCalledTimes(1)
    s.request.mockImplementation(delegate)
    await vi.advanceTimersByTimeAsync(2000)
    expect(s.request).toHaveBeenCalledTimes(2)
    expect(failed).toBe(false)
    s.lifetime.abort(); await session.close(); await s.worker.close(); await s.service.close()
  })
  it.each(['unavailable', 'DATABASE_READ_TIMEOUT', 'transport'])(
    'resumes collection at the normal interval after a transient %s response', async code => {
      vi.useFakeTimers()
      const s = setup()
      s.request.mockImplementationOnce(async () => { throw new DeviceApplicationError(code) })
      const session = await startRemoteTelemetrySession({ service: s.service, binding,
        signal: s.lifetime.signal, request: s.request })
      const failures: unknown[] = []
      void session.completion.catch(error => { failures.push(error) })
      try {
        await vi.advanceTimersByTimeAsync(1999)
        expect(s.request).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(s.request).toHaveBeenCalledTimes(2)
        expect(failures).toEqual([])
        expect(await s.service.availableComputerMemory({
          hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
          applicationInstallationId: binding.workerInstallationId, bootId: binding.bootId,
          keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision,
        }, s.lifetime.signal)).toBe(1)
      } finally {
        s.lifetime.abort()
        await session.close()
        await s.worker.close()
        await s.service.close()
      }
    })
  it.each(['permission', 'revoked'])('ends collection after a terminal %s response', async code => {
    vi.useFakeTimers()
    const s = setup()
    s.request.mockImplementationOnce(async () => { throw new DeviceApplicationError(code) })
    const session = await startRemoteTelemetrySession({ service: s.service, binding,
      signal: s.lifetime.signal, request: s.request })
    try {
      await expect(session.completion).rejects.toThrow(code)
      await vi.advanceTimersByTimeAsync(2000)
      expect(s.request).toHaveBeenCalledTimes(1)
    } finally {
      s.lifetime.abort()
      await session.close()
      await s.worker.close()
      await s.service.close()
    }
  })
  it('denies revoked authority before sending a collection request', async () => {
    const s = setup(); s.revoke()
    await expect(startRemoteTelemetrySession({ service: s.service, binding, signal: s.lifetime.signal, request: s.request })).rejects.toThrow('authorization')
    expect(s.request).not.toHaveBeenCalled(); await s.worker.close(); await s.service.close()
  })
  it('rejects spoofed installations and stale callbacks before initializing a collector', async () => {
    const s = setup(), challenge = await s.challenge()
    challenge.identity.host.applicationInstallationId = 'other'
    await expect(s.request({ operation: 'collect', challenge }, {})).rejects.toThrow('identity')
    s.change({ ...binding, connectionEpoch: 'replacement' })
    await expect(s.request({ operation: 'collect', challenge }, {})).rejects.toThrow('session-generation')
    expect(s.createCollector).not.toHaveBeenCalled(); await s.worker.close(); await s.service.close()
  })
  it('uses collector lifetime rather than request lifetime and joins the prior generation', async () => {
    const s = setup(), challenge = await s.challenge(), request = new AbortController()
    await s.request({ operation: 'collect', challenge }, { signal: request.signal })
    request.abort(); expect(s.collectors[0]!.signal.aborted).toBe(false)
    const next = structuredClone(challenge); next.identity.host.collectorGeneration = 'new'; next.challengeId = 'new'
    await s.request({ operation: 'collect', challenge: next }, {})
    expect(s.collectors[0]!.signal.aborted).toBe(true); expect(s.collectors[0]!.close).toHaveBeenCalledTimes(1)
    expect(s.createCollector).toHaveBeenCalledTimes(2)
    await s.worker.close(); await s.service.close()
  })
})
