import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { cleanupDeliveryFixtures } from './helpers/cleanupDelivery.js'

describe.skipIf(!postgresEnabled)('PostgreSQL Run cleanup boundaries', () => {
  const { fixture, database } = cleanupDeliveryFixtures()

  it('cleanup without user Stop fences authority and actual cancellation settles the Run as failed', async () => {
    const f = await fixture()
    const owner = await f.runs.acquireOwnership(f.f.run.id, () => undefined)
    if (!owner) throw new Error('Expected Run owner')
    try { await f.runs.requestCleanup(f.f.run.id, owner) } finally { await owner.release() }
    await expect(f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(f.interaction))).rejects.toBeDefined()
    await f.engine.cancel(f.f.run.id)
    expect((await f.repository.get(f.interaction.id))?.status).toBe('canceled')
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('failed')
    expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
    expect(await f.runs.hasRequestedStop(f.f.run.id)).toBe(false)
    expect(await f.receipts()).toEqual([])
    expect(f.provider.counts.starts).toBe(2)
  }, 60000)

  it('unconfirmed provider closure retains cleanup without manufacturing closure or Stop', async () => {
    const f = await fixture()
    f.provider.beforeClose = async () => { throw new Error('Native closure unconfirmed') }
    const owner = await f.runs.acquireOwnership(f.f.run.id, () => undefined)
    if (!owner) throw new Error('Expected Run owner')
    try { await f.runs.requestCleanup(f.f.run.id, owner) } finally { await owner.release() }
    try {
      await expect(f.engine.cancel(f.f.run.id)).rejects.toBeDefined()
      expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(true)
      expect(await f.runs.hasRequestedStop(f.f.run.id)).toBe(false)
      expect(await f.receipts()).toEqual([])
      expect(f.provider.closedSessions.has(f.interaction.nativeSessionId)).toBe(false)
    } finally { delete f.provider.beforeClose; await f.engine.cancel(f.f.run.id) }
    expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
    expect(await f.runs.hasRequestedStop(f.f.run.id)).toBe(false)
    expect(f.provider.counts.starts).toBe(2)
  }, 60000)

  it('clears a current Run cleanup intent with no native or review work', async () => {
    const db = database()
    const f = await currentRepositoryFixture(db)
    const owner = await f.repository.acquireOwnership(f.f.run.id, () => undefined)
    if (!owner) throw new Error('Expected Run owner')
    try {
      await f.repository.requestCleanup(f.f.run.id, owner)
      await f.repository.settleOrphan(f.f.run.id, owner, false)
      await f.repository.finishCleanup(f.f.run.id, false, owner)
      expect(await f.repository.hasPendingCleanup(f.f.run.id)).toBe(false)
      expect(await f.repository.hasRequestedStop(f.f.run.id)).toBe(false)
      expect(await f.repository.listRepeatExecutions(f.f.run.id)).toEqual([])
    } finally { await owner.release() }
  }, 60000)
})
