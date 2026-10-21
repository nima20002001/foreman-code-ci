import { expect, it, vi } from 'vitest'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { deviceRequestTimeoutMs } from '../../devices/deviceRequestRetry.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'
import { pagePhysicalReadout, remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { WorkflowPhysicalReadoutSnapshots } from './workflowPhysicalReadoutSnapshots.js'

async function fixture() {
  const f = await physicalFixture()
  const history = { ...f.source.history, events: [{ sequence: 0, type: 'native.notification',
    occurredAt: new Date().toISOString(), payload: { text: 'output'.repeat(55_000) } }] }
  const source = { type: 'history' as const, history }
  const snapshots = new WorkflowPhysicalReadoutSnapshots()
  const starts: string[] = []
  const continuations: string[] = []
  let readout = { ...f.readout, history }
  f.request.mockImplementation(async payload => {
    const request = RemoteExecutionRpcRequestSchema.parse(payload)
    if (request.method !== 'physical-readout') throw new Error('Expected a physical readout request')
    expect(request.receiptSequence).toBe(f.readout.receipt.sequence)
    expect(request.sourceDigest).toBe(remoteWorkflowSourceDigest(source))
    if (request.metadata) {
      continuations.push(request.metadata.digest)
      return { payload: pagePhysicalReadout(snapshots.read(request, request.metadata.digest), request.metadata) }
    }
    readout = { ...readout, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const first = pagePhysicalReadout(readout)
    if (!('kind' in first)) throw new Error('Expected a paged physical readout')
    snapshots.remember(request, readout, first.metadata)
    starts.push(first.metadata.digest)
    return { payload: first }
  })
  return { ...f, source, starts, continuations, readout: () => readout,
    replace: (value: typeof readout) => { readout = value } }
}

it('restarts the physical observation after a continuation timeout outlasts its snapshot', async () => {
  const f = await fixture()
  const serve = f.request.getMockImplementation()!
  let stalled = false
  vi.useFakeTimers()
  f.request.mockImplementation(async (payload, options) => {
    const request = RemoteExecutionRpcRequestSchema.parse(payload)
    if (request.method === 'physical-readout' && request.metadata && !stalled) {
      stalled = true
      vi.setSystemTime(Date.now() + deviceRequestTimeoutMs)
      throw new DeviceApplicationError('timeout')
    }
    return serve(payload, options)
  })
  try {
    const result = f.producer.prefetch(f.readout().receipt, f.placement, f.source)
    const checked = expect(result).resolves.toMatchObject({ kind: 'original-remote-physical' })
    await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(1_000)])
    await checked
    expect(f.producer.confirmedClosed(await result, f.session)).toBe(false)
    expect(f.starts).toHaveLength(2)
    expect(f.starts[1]).not.toBe(f.starts[0])
    expect(f.continuations[0]).toBe(f.starts[0])
    expect(f.continuations.slice(1).length).toBeGreaterThan(1)
    expect(f.continuations.slice(1).every(digest => digest === f.starts[1])).toBe(true)
  } finally {
    vi.useRealTimers()
    await f.sqlConnection.close()
  }
})

it('stops after five complete physical observations expire during continuation', async () => {
  const f = await fixture()
  const serve = f.request.getMockImplementation()!
  const expired = new DeviceApplicationError('transfer-expired')
  f.request.mockImplementation(async (payload, options) => {
    const request = RemoteExecutionRpcRequestSchema.parse(payload)
    if (request.method === 'physical-readout' && request.metadata) throw expired
    return serve(payload, options)
  })
  try {
    await expect(f.producer.prefetch(f.readout().receipt, f.placement, f.source)).rejects.toBe(expired)
    expect(f.starts).toHaveLength(5)
    expect(f.request).toHaveBeenCalledTimes(10)
  } finally { await f.sqlConnection.close() }
})

it.each(['receipt', 'history', 'process', 'expiry'] as const)(
  'validates the fresh %s after restarting an expired physical continuation', async defect => {
    const f = await fixture()
    const serve = f.request.getMockImplementation()!
    let expired = false
    f.request.mockImplementation(async (payload, options) => {
      const request = RemoteExecutionRpcRequestSchema.parse(payload)
      if (request.method === 'physical-readout' && request.metadata && !expired) {
        expired = true
        const readout = structuredClone(f.readout())
        if (defect === 'receipt') readout.receipt.sequence++
        if (defect === 'history') readout.history.events[0]!.payload = { text: 'replacement'.repeat(55_000) }
        if (defect === 'process') readout.observation.owner = 'execution:replacement'
        f.replace(readout)
        throw new DeviceApplicationError('transfer-expired')
      }
      const reply = await serve(payload, options)
      if (expired && defect === 'expiry' && request.method === 'physical-readout' && !request.metadata) {
        return { payload: { ...f.readout(), expiresAt: new Date(Date.now() - 1).toISOString() } }
      }
      return reply
    })
    try {
      const reasons = { receipt: 'readout_receipt', history: 'history_identity',
        process: 'process_identity', expiry: 'connection_expired' }
      await expect(f.producer.prefetch(f.readout().receipt, f.placement, f.source)).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: reasons[defect] },
      })
      expect(f.starts).toHaveLength(2)
    } finally { await f.sqlConnection.close() }
  },
)

it.each(['abort', 'connection'] as const)(
  'checks %s before restarting an expired physical observation', async change => {
    const f = await fixture()
    const serve = f.request.getMockImplementation()!
    const controller = new AbortController()
    const stopped = new Error('Observation canceled')
    f.request.mockImplementation(async (payload, options) => {
      const request = RemoteExecutionRpcRequestSchema.parse(payload)
      if (request.method === 'physical-readout' && request.metadata) {
        if (change === 'abort') controller.abort(stopped)
        else f.currentBinding.mockReturnValue({ ...f.context.binding, connectionGeneration: 4 })
        throw new DeviceApplicationError('transfer-expired')
      }
      return serve(payload, options)
    })
    try {
      const result = f.producer.prefetch(f.readout().receipt, f.placement, f.source, controller.signal)
      if (change === 'abort') await expect(result).rejects.toBe(stopped)
      else await expect(result).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'connection_expired' },
      })
      expect(f.starts).toHaveLength(1)
      expect(f.request).toHaveBeenCalledTimes(2)
    } finally { await f.sqlConnection.close() }
  },
)
