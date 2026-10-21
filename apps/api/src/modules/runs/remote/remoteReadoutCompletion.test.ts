import { expect, it, vi } from 'vitest'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { DeviceHistoryGap } from '@foreman-code/contracts/device-application'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { DeviceApplicationError, deviceApplicationFailure } from '../../devices/deviceApplicationError.js'
import { CodexAppServerSessionManager } from '../../harnesses/codexAppServer.js'
import { runningInstalledFixture } from './__tests__/installedWorkflowHost.js'
import { RemoteNativeSessionManager } from './nativeManagerProxy.js'
import { createRemoteWorkflowPhysicalVerification } from './workflowPhysicalVerification.js'

function event(sequence: number): NativeHarnessEvent {
  return { sequence, type: 'native.notification', occurredAt: '2026-10-01T00:00:00.000Z',
    payload: { text: `Native event ${sequence}` } }
}

it.each(['current channel', 'older channel', 'direct handler'] as const)(
  'delivers the finished native result after an observed readout is evicted through the %s', async boundary => {
    const f = await runningInstalledFixture()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    f.history.events = [event(38), event(39)]
    f.history.firstRetainedSequence = 38
    f.history.nextSequence = 40
    vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcileHistoryPage')
      .mockImplementation(async () => structuredClone(f.history))
    const result = { outcome: 'succeeded' as const, output: { text: 'The original native deliverable' } }
    let delayObservation = false
    let evictBeforeRead = false
    let evictions = 0
    let confirmedClosed = false
    let finished = false
    const reads: string[] = []
    const physical = createRemoteWorkflowPhysicalVerification({ endpoint: () => ({
      currentBinding: () => f.context.binding,
      captureRequest: () => {
        if (delayObservation) {
          delayObservation = false
          // Admission/publication can outlast both the served window and its latency allowance.
          now += 121_000
          evictBeforeRead = true
        }
        return { binding: f.context.binding, request: async raw => {
          const frame = RemoteExecutionRpcRequestSchema.parse(raw)
          if (frame.method !== 'physical-readout') throw new Error('Expected physical observation')
          reads.push(frame.sourceDigest)
          if (evictBeforeRead) {
            evictBeforeRead = false
            // Distinct live observations fill the bounded store after Main read the earlier page.
            for (let index = 0; index < 129; index++) {
              const sequence = 286 + index
              f.history.events = [event(sequence)]
              f.history.firstRetainedSequence = sequence
              f.history.nextSequence = sequence + 1
              await f.call('history', { afterSequence: sequence - 1, correlationId: 'execution:execution' })
            }
            await expect(f.call('physical-readout', frame)).rejects.toMatchObject({
              code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'not_retained' },
            })
            evictions++
            f.finish('succeeded', result.output)
            finished = true
            await f.settled
          }
          try {
            return await f.call('physical-readout', frame)
          } catch (error) {
            if (boundary === 'direct handler') throw error
            const failure = deviceApplicationFailure(error)
            // Older Workers serialize the generic code without the not_retained reason.
            const code = boundary === 'older channel' && failure.code === 'REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED'
              ? 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' : failure.code
            throw new DeviceApplicationError(code)
          }
        } }
      },
    }) })
    const requests: string[] = []
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement,
      harness: 'codex', configuration: f.request.configuration,
      transport: { request: async (method, raw) => {
        requests.push(method)
        return structuredClone((await f.call(method, RemoteExecutionRpcRequestSchema.parse(raw))).payload)
      } },
      observeReceipt: async () => {},
      observeOriginalSource: async (receipt, source, signal) => {
        const prepared = await physical.prefetch(receipt, f.placement, source, signal)
        confirmedClosed = physical.confirmedClosed(prepared, f.session)
      },
      controlFor: async () => { throw new Error('Readout recovery must not restart or cancel the turn') },
    })
    try {
      await proxy.attachSession(f.session, { request: f.request, correlationId: 'execution:execution' })
      const skipped: DeviceHistoryGap[] = []
      const delivered: NativeHarnessEvent[] = []
      const stream = proxy.startTurn(f.session, { prompt: 'original prompt',
        clientCorrelationId: 'execution:execution', onEventsSkipped: async gap => { skipped.push(gap) } })
      const first = await stream.next()
      expect(first).toEqual({ done: false, value: event(38) })
      if (first.done) throw new Error('Expected the first native event')
      delivered.push(first.value)
      delayObservation = true
      for await (const frame of stream) delivered.push(frame)
      const completion = await proxy.reconcile(f.session, 'execution:execution')
      expect(evictions).toBe(1)
      expect(delivered).toEqual([event(38), event(414)])
      expect(skipped).toEqual([
        { fromSequence: 0, toSequence: 37, reason: 'retention' },
        { fromSequence: 39, toSequence: 413, reason: 'retention' },
      ])
      expect(completion.terminalTurn).toEqual({ correlationId: 'execution:execution',
        providerId: 'original-turn', result })
      expect(confirmedClosed).toBe(true)
      expect(reads.filter(digest => digest === reads[2])).toHaveLength(1)
      expect(requests).toEqual(['reattach', 'start-turn', 'history', 'history', 'history'])
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.cancel).not.toHaveBeenCalled()
    } finally {
      if (!finished) f.finish('canceled')
      await f.settled
      await f.host.close()
    }
  },
)
