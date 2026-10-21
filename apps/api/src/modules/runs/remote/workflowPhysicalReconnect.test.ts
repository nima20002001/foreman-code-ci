import { expect, it, vi } from 'vitest'
import { DeviceConnectionError } from '../../devices/deviceWire.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'
import { createRemoteWorkflowPhysicalVerification } from './workflowPhysicalVerification.js'
import { pagePhysicalReadout } from './workflowPhysicalReadout.js'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'

it.each(['initial', 'continuation'] as const)(
  'refreshes the whole physical observation after a link drop during the %s request', async stage => {
    const f = await physicalFixture()
    const history = { ...f.source.history, events: [{ sequence: 0, type: 'native.notification',
      occurredAt: new Date().toISOString(), payload: { text: 'output'.repeat(55_000) } }] }
    const source = { type: 'history' as const, history }
    const readout = { ...f.readout, history }
    let connected = true
    let dropped = false
    let starts = 0
    const replacement = { ...f.context.binding, connectionGeneration: f.context.binding.connectionGeneration + 1,
      connectionEpoch: 'reconnected-epoch' }
    const fresh = vi.fn(async (raw: unknown) => {
      const frame = RemoteExecutionRpcRequestSchema.parse(raw)
      if (frame.method !== 'physical-readout') throw new Error('Expected physical observation')
      if (!frame.metadata) starts++
      return { payload: pagePhysicalReadout(readout, frame.metadata) }
    })
    const original = vi.fn(async (raw: unknown) => {
      const frame = RemoteExecutionRpcRequestSchema.parse(raw)
      if (frame.method !== 'physical-readout') throw new Error('Expected physical observation')
      if (stage === 'initial' || frame.metadata) {
        connected = false
        dropped = true
        setTimeout(() => { connected = true }, 250)
        throw new DeviceConnectionError('transport')
      }
      starts++
      return { payload: pagePhysicalReadout(readout) }
    })
    const producer = createRemoteWorkflowPhysicalVerification({ endpoint: () => ({
      currentBinding: () => connected ? (dropped ? replacement : f.context.binding) : undefined,
      captureRequest: () => connected ? { binding: dropped ? replacement : f.context.binding,
        request: dropped ? fresh : original } : undefined,
    }) })
    vi.useFakeTimers()
    try {
      const result = producer.prefetch(readout.receipt, f.placement, source)
      const checked = expect(result).resolves.toMatchObject({ kind: 'original-remote-physical' })
      await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(1_000)])
      await checked
      expect(producer.confirmedClosed(await result, f.session)).toBe(false)
      expect(starts).toBe(stage === 'initial' ? 1 : 2)
      expect(fresh).toHaveBeenCalled()
      const frame = RemoteExecutionRpcRequestSchema.parse(fresh.mock.calls[0]![0])
      expect(frame.method).toBe('physical-readout')
      expect(frame).not.toHaveProperty('metadata')
      expect(original).toHaveBeenCalledTimes(stage === 'initial' ? 1 : 2)
    } finally {
      vi.useRealTimers()
      await f.sqlConnection.close()
    }
  },
)
