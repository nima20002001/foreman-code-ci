import { describe, expect, it } from 'vitest'
import { DEVICE_HISTORY_PAGE_BYTES } from '@foreman-code/contracts/device-application'
import { InstalledWorkflowPhysicalReadouts, pagePhysicalReadout, readPhysicalReadout,
  remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'

describe('physical readout retention while an operation is being cleaned up', () => {
  it('retains the cleanup reply of an operation whose every slot Main still holds, and still refuses an ordinary reply', async () => {
    const f = await physicalFixture(), readouts = new InstalledWorkflowPhysicalReadouts()
    const history = (index: number) => ({ ...f.source.history, nextSequence: index })
    const observation = (index: number, cleanup = false) => ({ readout: { ...f.readout, history: history(index) },
      placement: f.placement, source: { type: 'history' as const, history: history(index) },
      leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: async () => {}, assertCurrent: async () => {},
      observe: () => f.captured.launch, closure: () => null, ...(cleanup ? { cleanup: true } : {}) })
    const selector = (index: number) => ({ intent: f.intent, placement: f.placement,
      receiptSequence: f.readout.receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: history(index) }) })
    try {
      for (let index = 0; index < 128; index++) {
        readouts.remember(observation(index))
        await readouts.read(selector(index))
      }
      expect(() => readouts.remember(observation(128)))
        .toThrow(expect.objectContaining({ code: 'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE' }))
      // Cancel and close replies free the operation's capacity; refusing them would wedge its closure forever.
      expect(() => readouts.remember(observation(129, true))).not.toThrow()
      expect((await readouts.read(selector(129))).history).toEqual(history(129))
      // Only the operation's oldest observation yields; Main re-reads it as an expired reply.
      await expect(readouts.read(selector(0))).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'not_retained' } })
      expect((await readouts.read(selector(1))).history).toEqual(history(1))
    } finally { await f.sqlConnection.close() }
  })

  it('releases paging snapshots when cleanup displaces held replies', async () => {
    const f = await physicalFixture()
    const readouts = new InstalledWorkflowPhysicalReadouts()
    const history = (index: number) => ({ ...f.source.history, nextSequence: index,
      events: [{ sequence: 0, type: 'native.notification', occurredAt: f.execution.createdAt,
        payload: { text: 's'.repeat(DEVICE_HISTORY_PAGE_BYTES) } }] })
    const selector = (index: number) => ({ intent: f.intent, placement: f.placement,
      receiptSequence: f.readout.receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: history(index) }) })
    try {
      for (let index = 0; index < 80; index++) {
        const original = history(index)
        readouts.remember({ readout: { ...f.readout, history: original }, placement: f.placement,
          source: { type: 'history', history: original }, cleanup: true,
          leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: async () => {},
          assertCurrent: async () => {}, observe: () => f.captured.launch, closure: () => null })
        const selected = await readouts.read(selector(index))
        const first = pagePhysicalReadout(selected)
        expect(first).toHaveProperty('kind', 'result-continuation')
        expect(await readPhysicalReadout(first, async metadata =>
          pagePhysicalReadout(await readouts.read({ ...selector(index), metadata }), metadata))).toEqual(selected)
      }
      await expect(readouts.read(selector(0))).rejects.toMatchObject({ details: { reason: 'not_retained' } })
      expect((await readouts.read(selector(79))).history).toEqual(history(79))
    } finally { readouts.clear(); await f.sqlConnection.close() }
  })

  it('admits fresh cleanup pages by displacing only snapshots of the same operation', async () => {
    const f = await physicalFixture()
    let now = Date.now()
    const readouts = new InstalledWorkflowPhysicalReadouts(() => now)
    const history = { ...f.source.history, events: [{ sequence: 0, type: 'native.notification',
      occurredAt: f.execution.createdAt, payload: { text: 'p'.repeat(DEVICE_HISTORY_PAGE_BYTES) } }] }
    const source = { type: 'history' as const, history }
    const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest(source) }
    const remember = (operationId: string, cleanup: boolean) => readouts.remember({
      readout: { ...f.readout, history, receipt: { ...f.readout.receipt,
        intent: { ...f.intent, operationId } } }, placement: f.placement, source, cleanup,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: async () => {},
      assertCurrent: async () => {}, observe: () => f.captured.launch, closure: () => null })
    try {
      remember('other-operation', false)
      const otherSelector = { ...selector, intent: { ...f.intent, operationId: 'other-operation' } }
      const other = await readouts.read(otherSelector)
      const otherPage = pagePhysicalReadout(other)
      remember(f.intent.operationId, true)
      let first: ReturnType<typeof pagePhysicalReadout> | undefined
      for (let index = 0; index < 80; index++) {
        now++
        const readout = await readouts.read(selector)
        first ??= pagePhysicalReadout(readout)
        expect(readout.history).toEqual(history)
      }
      if (!first || !('kind' in first)) throw new Error('Expected cleanup paging')
      const metadata = { digest: first.metadata.digest,
        offset: Buffer.from(first.metadata.data, 'base64').byteLength }
      await expect(readouts.read({ ...selector, metadata })).rejects.toMatchObject({ code: 'transfer-expired' })
      expect(await readPhysicalReadout(otherPage, async metadata =>
        pagePhysicalReadout(await readouts.read({ ...otherSelector, metadata }), metadata))).toEqual(other)
    } finally { readouts.clear(); await f.sqlConnection.close() }
  })
})
