import { afterEach, describe, expect, it, vi } from 'vitest'
import { afPublicationFixture } from './helpers/afPublicationFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { preparePublication } from './helpers/codexPublication.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('publication recovery after native completion', { timeout: 90_000 }, () => {
  for (const failure of ['adopt_once', 'revoke_after_finalize'] as const) {
    it(`Codex terminal close repairs ${failure} without another publication`, async () => {
      const f = await afPublicationFixture()
      const t = await preparePublication(f, 1, failure)
      const publish = vi.spyOn(f.service, 'publish')
      // Production bound its method through a wrapper, so this spy observes the real service call.
      expect((await t.publish()).success).toBe(false)
      const original = await f.publications(t.active.turn.messageId)
      expect(original).toHaveLength(1)
      expect((await f.stored(t.active.turn.messageId)).publicationRefs).toBeUndefined()
      f.native.finish(); await f.settle()
      expect((await f.stored(t.active.turn.messageId)).publicationRefs).toEqual(original)
      expect(await f.readPins(t.active.turn.messageId)).toEqual([...t.attachments, ...original])
      await t.bridge.close(); await t.admission.adoptPublished(t.active.turn.nativeTurnId!, [])
      expect(await f.readPins(t.active.turn.messageId)).toEqual([...t.attachments, ...original])
      expect(await f.publications(t.active.turn.messageId)).toEqual(original)
      expect(publish).toHaveBeenCalledTimes(1)
      expect(f.hosts.every((host) => host.closed)).toBe(true)
      expect((await f.database.pool.query(`select 1 from file_tool_sessions where revoked_at is null
        and record->'context'->>'messageId'=$1`, [t.active.turn.messageId])).rowCount).toBe(0)
      vi.restoreAllMocks()
      const next = await f.nextTurn()
      expect(await f.readPins(next.turn.messageId)).toHaveLength(1)
      expect(await f.readPins(next.turn.messageId)).not.toEqual(expect.arrayContaining(original))
    })
  }

  it('a reconstructed transcript recovers the ledger even if the process never ran close', async () => {
    const f = await afPublicationFixture(), t = await preparePublication(f, 1, 'lose_close')
    expect((await t.publish()).success).toBe(false)
    const original = await f.publications(t.active.turn.messageId)
    expect(original).toHaveLength(1)
    // Simulate a lost in-memory close callback; only PostgreSQL knows this pin.
    f.native.onFinish = undefined
    await f.database.pool.query(`update file_tool_sessions set revoked_at=clock_timestamp()
      where record->'context'->>'messageId'=$1`, [t.active.turn.messageId])
    f.native.finish(); await f.settle()
    expect((await f.stored(t.active.turn.messageId)).publicationRefs).toBeUndefined()
    expect(await f.readPins(t.active.turn.messageId)).toEqual([...t.attachments, ...original])
    expect(await f.readPins(t.active.turn.messageId)).toEqual([...t.attachments, ...original])
    expect(await f.publications(t.active.turn.messageId)).toEqual(original)
    await t.bridge.close() // Test-owned synthetic host still gets cleaned up.
    await f.nextTurn()
  })

  it('a linked but unfinalized publication is not exposed by close or restart readback', async () => {
    const f = await afPublicationFixture(), t = await preparePublication(f, 1)
    vi.spyOn(f.files, 'finalize').mockRejectedValueOnce(new Error('Injected failure before finalization'))
    expect((await t.publish()).success).toBe(false)
    expect((await f.database.pool.query(`select 1 from file_tool_publications
      where record->'context'->>'messageId'=$1`, [t.active.turn.messageId])).rowCount).toBe(1)
    expect(await f.publications(t.active.turn.messageId)).toEqual([])
    f.native.finish(); await f.settle()
    expect(await f.readPins(t.active.turn.messageId)).toEqual(t.attachments)
    expect((await f.stored(t.active.turn.messageId)).publicationRefs).toEqual([])
  })
})
