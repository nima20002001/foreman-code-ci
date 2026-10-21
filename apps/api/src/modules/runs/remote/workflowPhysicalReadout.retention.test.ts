import { expect, it, vi } from 'vitest'
import { DeviceApplicationError, deviceApplicationFailure } from '../../devices/deviceApplicationError.js'
import { DomainError } from '../../errors.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'
import { InstalledWorkflowPhysicalReadouts, remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'

it('classifies a physical reply evicted during admission as an expired reply rather than a lost process', async () => {
  const f = await physicalFixture()
  const readouts = new InstalledWorkflowPhysicalReadouts()
  const remember = (sequence: number) => readouts.remember({
    readout: { ...f.readout, receipt: { ...f.readout.receipt, sequence } },
    placement: f.placement, source: f.source,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    assertOwnerCurrent: async () => {}, assertCurrent: async () => {},
    observe: () => f.captured.launch, closure: () => null,
  })
  const selector = { intent: f.intent, placement: f.placement, receiptSequence: 1,
    sourceDigest: remoteWorkflowSourceDigest(f.source) }
  try {
    for (let sequence = 1; sequence <= 129; sequence++) remember(sequence)
    const missing = await readouts.read(selector).catch((error: unknown) => error)
    expect(missing).toMatchObject({ details: { reason: 'not_retained' } })
    expect(deviceApplicationFailure(missing)).toEqual({
      code: 'REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED', class: 'transient', retryable: true,
    })
    // Refreshing the same original process restores readback without increasing retention capacity.
    remember(1)
    expect((await readouts.read(selector)).receipt.sequence).toBe(1)
  } finally {
    readouts.clear()
    await f.sqlConnection.close()
  }
})

it.each([
  ['read', 'raw'], ['read', 'serialized'], ['ack', 'raw'], ['ack', 'serialized'],
] as const)('retains original replies after a %s authorization failure (%s)', async (operation, boundary) => {
  const f = await physicalFixture()
  const readouts = new InstalledWorkflowPhysicalReadouts()
  const authorize = vi.fn(async () => {})
  readouts.remember({ readout: f.readout, placement: f.placement, source: f.source,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: authorize, assertCurrent: authorize,
    observe: () => f.captured.launch, closure: () => null })
  const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
    sourceDigest: remoteWorkflowSourceDigest(f.source) }
  try {
    for (const original of [
      new Error('timeout exceeded when trying to connect'),
      Object.assign(new Error('Connection lost'), { code: '08006' }),
      Object.assign(new Error('Socket reset'), { code: 'ECONNRESET' }),
    ]) {
      const serialized = JSON.parse(JSON.stringify(deviceApplicationFailure(original))) as { code: string }
      const failure = boundary === 'raw' ? original : new DeviceApplicationError(serialized.code)
      authorize.mockRejectedValueOnce(failure)
      await expect(readouts[operation](selector)).rejects.toBe(failure)
      expect(await readouts.read(selector)).toEqual(f.readout)
    }
  } finally {
    readouts.clear()
    await f.sqlConnection.close()
  }
})

it.each(['read', 'ack'] as const)('purges original replies after a permanent %s authorization denial', async operation => {
  const f = await physicalFixture()
  const readouts = new InstalledWorkflowPhysicalReadouts()
  const authorize = vi.fn(async () => {})
  readouts.remember({ readout: f.readout, placement: f.placement, source: f.source,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: authorize, assertCurrent: authorize,
    observe: () => f.captured.launch, closure: () => null })
  const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
    sourceDigest: remoteWorkflowSourceDigest(f.source) }
  try {
    authorize.mockRejectedValueOnce(new DomainError('AUTH_REVOKED', 'Owner revoked access.', 401))
    await expect(readouts[operation](selector)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    await expect(readouts.read(selector)).rejects.toMatchObject({
      code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'not_retained' },
    })
  } finally {
    readouts.clear()
    await f.sqlConnection.close()
  }
})
