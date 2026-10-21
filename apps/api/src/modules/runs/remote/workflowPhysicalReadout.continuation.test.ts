import { expect, it, vi } from 'vitest'
import { Hash } from 'node:crypto'
import { DEVICE_HISTORY_PAGE_BYTES } from '@foreman-code/contracts/device-application'
import { RemoteReceiptPageSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeLaunchObservation } from '../../harnesses/recovery/processRegistry.js'
import { REMOTE_PHYSICAL_CONTINUATION_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import { deviceApplicationFailure } from '../../devices/deviceApplicationError.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'
import { nativeHistoryPageSource, pageNativeHistory } from './nativeHistoryPage.js'
import { readJsonContinuation } from './jsonContinuation.js'
import { decodeResultCopies } from './executionResultCodec.js'
import { InstalledWorkflowResponsePages, readRemoteReceiptResponse } from './installedWorkflowResponsePages.js'
import {
  InstalledWorkflowPhysicalReadouts,
  pagePhysicalReadout,
  readPhysicalReadout,
  remoteWorkflowSourceDigest,
} from './workflowPhysicalReadout.js'

function observeSnapshotHashing() {
  const update = vi.spyOn(Hash.prototype, 'update')
  return {
    bytes: () => update.mock.calls.reduce((total, [data]) => {
      const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
      return total + (size > DEVICE_HISTORY_PAGE_BYTES ? size : 0)
    }, 0),
    close: () => update.mockRestore(),
  }
}

async function fixture() {
  const f = await physicalFixture()
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const history = { ...f.source.history, events: [{ sequence: 1, type: 'native.notification',
    occurredAt: new Date(now).toISOString(), payload: { text: 'output'.repeat(55_000) } }] }
  const source = { type: 'history' as const, history }
  const readouts = new InstalledWorkflowPhysicalReadouts()
  let observation: NativeLaunchObservation = f.captured.launch
  const authorize = vi.fn(async () => {})
  const remember = () => readouts.remember({ readout: { ...f.readout, history,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }, placement: f.placement, source,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: authorize, assertCurrent: authorize,
    observe: () => observation, closure: () => observation.lifecycle === 'closed' ? observation : null })
  remember()
  const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
    sourceDigest: remoteWorkflowSourceDigest(source) }
  return { ...f, now, clock, readouts, remember, selector, authorize,
    closeNative: () => { observation = { ...observation, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' } },
    close: async () => { readouts.clear(); clock.mockRestore(); await f.sqlConnection.close() } }
}

it.each(['expiry renewal', 'native closure', 'concurrent refresh'] as const)(
  'keeps one physical snapshot across pages during %s', async change => {
    const f = await fixture()
    try {
      f.clock.mockReturnValue(f.now + 59_000)
      const selected = await f.readouts.read(f.selector)
      const first = pagePhysicalReadout(selected)
      if (!('kind' in first)) throw new Error('Expected a paged physical readout')
      f.clock.mockReturnValue(f.now + 61_000)
      if (change === 'native closure') f.closeNative()
      if (change === 'concurrent refresh') {
        f.remember()
        await f.readouts.read(f.selector)
      }
      const reconstructed = await readPhysicalReadout(first, async metadata =>
        pagePhysicalReadout(await f.readouts.read({ ...f.selector, metadata }), metadata))
      expect(reconstructed).toEqual(selected)
      expect(Date.parse(reconstructed.expiresAt)).toBeGreaterThan(Date.now())
      expect(f.authorize.mock.calls.length).toBeGreaterThan(1)
    } finally {
      await f.close()
    }
  })

it.each(['expired', 'acknowledged', 'purged'] as const)(
  'does not retry an %s physical continuation that cannot be served', async reason => {
    const f = await fixture()
    try {
      const first = pagePhysicalReadout(await f.readouts.read(f.selector))
      if (!('kind' in first)) throw new Error('Expected a paged physical readout')
      const metadata = { digest: first.metadata.digest, offset: Buffer.from(first.metadata.data, 'base64').byteLength }
      if (reason === 'expired') f.clock.mockReturnValue(f.now + 121_000)
      if (reason === 'acknowledged') await f.readouts.ack(f.selector)
      if (reason === 'purged') f.readouts.purge(f.intent.operationId)
      const failure = await f.readouts.read({ ...f.selector, metadata }).then(() => undefined, error => error)
      expect(deviceApplicationFailure(failure)).toEqual({ code: 'transfer-expired', class: 'permanent', retryable: false })
    } finally {
      await f.close()
    }
  })

it('does not serve a saved continuation after authorization is denied', async () => {
  const f = await fixture()
  try {
    const first = pagePhysicalReadout(await f.readouts.read(f.selector))
    if (!('kind' in first)) throw new Error('Expected a paged physical readout')
    const metadata = { digest: first.metadata.digest, offset: Buffer.from(first.metadata.data, 'base64').byteLength }
    const denied = Object.assign(new Error('Access revoked'), { code: 'AUTH_REVOKED' })
    f.authorize.mockRejectedValueOnce(denied)
    await expect(f.readouts.read({ ...f.selector, metadata })).rejects.toBe(denied)
  } finally {
    await f.close()
  }
})

it('codes an oversized physical readout as permanently too large', async () => {
  const f = await physicalFixture()
  try {
    const history = { ...f.source.history, events: [{ sequence: 1, type: 'native.notification',
      occurredAt: new Date().toISOString(), payload: { text: 'x'.repeat(REMOTE_PHYSICAL_CONTINUATION_LIMIT) } }] }
    let failure: unknown
    try {
      pagePhysicalReadout({ ...f.readout, history })
    } catch (error) {
      failure = error
    }
    expect(deviceApplicationFailure(failure)).toEqual({ code: 'payload-too-large', class: 'permanent', retryable: false })
  } finally {
    await f.sqlConnection.close()
  }
})

it('keeps an active paged reply while evicting unread histories oldest first', async () => {
  const f = await fixture()
  try {
    const selected = await f.readouts.read(f.selector)
    const first = pagePhysicalReadout(selected)
    if (!('kind' in first)) throw new Error('Expected a paged physical readout')
    let oldest: typeof f.selector | undefined
    for (let index = 0; index < 140; index++) {
      const history = { ...f.source.history, nextSequence: index }
      const source = { type: 'history' as const, history }
      const selector = { ...f.selector, sourceDigest: remoteWorkflowSourceDigest(source) }
      oldest ??= selector
      f.readouts.remember({ readout: { ...f.readout, history }, placement: f.placement, source,
        leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: f.authorize, assertCurrent: f.authorize,
        observe: () => f.captured.launch, closure: () => null })
    }
    await expect(f.readouts.read(oldest!)).rejects.toMatchObject({ details: { reason: 'not_retained' } })
    expect(await readPhysicalReadout(first, async metadata =>
      pagePhysicalReadout(await f.readouts.read({ ...f.selector, metadata }), metadata))).toEqual(selected)
  } finally {
    await f.close()
  }
})

it.each(['history', 'event'] as const)(
  'pages a growing session with dense events to completion through its %s selector', async selectorType => {
    const f = await physicalFixture()
    const readouts = new InstalledWorkflowPhysicalReadouts()
    const event = (sequence: number) => ({ sequence, type: 'native.notification',
      occurredAt: '2026-10-01T00:00:00.000Z', payload: { samples: Array<number>(64).fill(0) } })
    const events = Array.from({ length: 1500 }, (_, sequence) => event(sequence))
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(60_000) } }
    const history = { ...f.source.history, events, terminalResult: result,
      terminalTurn: { correlationId: f.source.history.correlationId, providerId: 'original-turn', result } }
    const remember = (afterSequence: number) => {
      const page = pageNativeHistory(history, afterSequence)
      const original = nativeHistoryPageSource(page)!
      const source = { type: 'history' as const, history: original }
      readouts.remember({ readout: { ...f.readout, history: original as typeof f.readout.history }, placement: f.placement, source,
        leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: async () => {},
        assertCurrent: async () => {}, observe: () => f.captured.launch, closure: () => null })
      const selectedSource = selectorType === 'history' ? source : { type: 'event' as const,
        event: { ...original.events[0]!, executionId: f.intent.executionId } }
      return { page, original, selector: { intent: f.intent, placement: f.placement,
        receiptSequence: f.readout.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(selectedSource) } }
    }
    const delivered: typeof events = []
    let cursor = -1
    let grew = false
    let pages = 0
    try {
      for (let count = 0; count < 10; count++) {
        const { page, original, selector } = remember(cursor)
        const selected = await readouts.read(selector)
        const first = pagePhysicalReadout(selected)
        expect(first).toHaveProperty('kind', 'result-continuation')
        const reconstructed = await readPhysicalReadout(first, async metadata => {
          pages++
          if (!grew) {
            grew = true
            events.push(...Array.from({ length: 300 }, (_, index) => event(events.length + index)))
            remember(cursor)
          }
          return pagePhysicalReadout(await readouts.read({ ...selector, metadata }), metadata)
        })
        expect(reconstructed).toEqual(selected)
        expect(reconstructed.history).toEqual(original)
        delivered.push(...reconstructed.history!.events as typeof events)
        await readouts.ack(selector)
        cursor = page.page.nextAfterSequence
        if (cursor === events.length - 1) break
      }
      expect(grew).toBe(true)
      expect(pages).toBeGreaterThan(10)
      expect(delivered).toEqual(events)
      expect(cursor).toBe(events.length - 1)
    } finally {
      readouts.clear()
      await f.sqlConnection.close()
    }
  })

it('finishes history metadata paging while the live session cursor advances', async () => {
  const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(60_000) } }
  const event = (sequence: number) => ({ sequence, type: 'native.notification',
    occurredAt: '2026-10-01T00:00:00.000Z', payload: { text: 'session output' } })
  const history = { events: Array.from({ length: 1500 }, (_, sequence) => event(sequence)),
    pendingInteractions: [], nextCursor: 'session:1500', terminalResult: result,
    terminalTurn: { correlationId: 'execution:execution', providerId: 'original-turn', result } }
  const first = pageNativeHistory(history, -1)
  expect(first.page.metadata).toBeDefined()
  let pages = 0
  const fields = await readJsonContinuation(first.page.metadata!, async metadata => {
    pages++
    history.events.push(event(history.events.length))
    history.nextCursor = `session:${history.events.length}`
    return pageNativeHistory(history, first.page.nextAfterSequence, metadata).page.metadata!
  })
  expect(pages).toBeGreaterThan(1)
  expect(history.nextCursor).not.toBe('session:1500')
  expect({ ...first.history, ...decodeResultCopies(fields) as object }).toEqual(nativeHistoryPageSource(first))
})

it('hashes a physical snapshot once while serving every continuation page', async () => {
  const f = await fixture()
  const hashing = observeSnapshotHashing()
  try {
    const selected = await f.readouts.read(f.selector)
    const first = pagePhysicalReadout(selected)
    if (!('kind' in first)) throw new Error('Expected a paged physical readout')
    let pages = 0
    const recovered = await readPhysicalReadout(first, async metadata => {
      pages++
      return pagePhysicalReadout(await f.readouts.read({ ...f.selector, metadata }), metadata)
    })
    expect(recovered).toEqual(selected)
    expect(pages).toBeGreaterThan(3)
    // One producer hash and one consumer integrity check, independent of page count.
    expect(hashing.bytes()).toBe(2 * first.metadata.byteSize)
  } finally {
    hashing.close()
    await f.close()
  }
})

it.each([1024 * 1024, 2 * 1024 * 1024])('hashes receipt pages in linear work for %i output bytes', async size => {
  const f = await physicalFixture()
  const pages = new InstalledWorkflowResponsePages()
  const receipt = { ...f.readout.receipt, phase: 'confirmed_terminal',
    terminal: { kind: 'completed', closureEvidenceDigest: 'a'.repeat(64),
      result: { outcome: 'succeeded', output: { text: 'r'.repeat(size) } } } }
  const frame = { method: 'status' as const, intent: f.intent, placement: f.placement }
  const hashing = observeSnapshotHashing()
  try {
    const raw = pages.page({ status: 'known', receipt }, frame, f.context.binding) as { receipt: unknown }
    const first = RemoteReceiptPageSchema.parse(raw.receipt)
    let continuations = 0
    const recovered = await readRemoteReceiptResponse(raw, f.intent, async request => {
      continuations++
      return pages.read({ ...frame, method: 'receipt-continuation', ...request }, f.context.binding)
    })
    expect(recovered).toEqual({ status: 'known', receipt })
    expect(continuations).toBeGreaterThan(3)
    expect(hashing.bytes()).toBe(2 * first.metadata.byteSize)
  } finally {
    hashing.close()
    pages.clear()
    await f.sqlConnection.close()
  }
})

it.each([256 * 1024, 1024 * 1024])('hashes history metadata in linear work for %i output bytes', async size => {
  const result = { outcome: 'succeeded' as const, output: { text: 'm'.repeat(size) } }
  const history = { events: [], pendingInteractions: [], terminalResult: result,
    terminalTurn: { correlationId: 'execution:execution', providerId: 'original-turn', result } }
  const hashing = observeSnapshotHashing()
  try {
    const first = pageNativeHistory(history).page.metadata!
    let pages = 0
    const recovered = await readJsonContinuation(first, async metadata => {
      pages++
      return pageNativeHistory(history, undefined, metadata).page.metadata!
    })
    expect(decodeResultCopies(recovered)).toEqual({ pendingInteractions: [], terminalResult: result,
      terminalTurn: history.terminalTurn })
    expect(pages).toBeGreaterThan(3)
    expect(hashing.bytes()).toBe(2 * first.byteSize)
  } finally {
    hashing.close()
  }
})
