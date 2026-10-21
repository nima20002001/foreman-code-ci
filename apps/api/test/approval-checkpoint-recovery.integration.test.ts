import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { productionFixtures, response, stageDelivered, checkpointCut, restart, expireAbandonedClaims, crashAfterCommitSaver } from './helpers/approvalCheckpointProduction.js'

describe.skipIf(!postgresEnabled)('approval checkpoint recovery', () => {
  const fixture = productionFixtures()

  it('recovers a delivered answer after restart and consumes its checkpoint exactly once without resending', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    await stageDelivered(f)
    const [interaction] = await f.pending(), cut = await checkpointCut(f)
    const before = { ...f.provider.counts }
    const successor = await restart(f)
    expect(f.provider.closedSessions.has(interaction!.nativeSessionId)).toBe(true)
    await successor.engine.resume(f.f.run.id)
    const receipts = await f.receipts()
    const committed = (await f.saver.getTuple(cut.config))?.pendingWrites
    expect(receipts).toEqual([expect.objectContaining({ entity_id: interaction!.id })])
    expect(committed?.filter((write) => write[1] === '__resume__')).toHaveLength(1)
    expect((await successor.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
    expect(await successor.repository.get(interaction!.id)).toMatchObject({
      status: 'delivered', deliveryState: 'delivered',
      nativeSessionId: interaction!.nativeSessionId,
    })
    for (let n = 0; n < 3; n++) {
      await successor.engine.resume(f.f.run.id)
      await successor.engine.resumeInteraction((await successor.repository.get(interaction!.id))!)
    }
    expect(await f.receipts()).toEqual(receipts)
    expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(committed)
    expect(f.provider.counts).toMatchObject({
      sessions: before.sessions, starts: before.starts, responses: 1, attaches: before.attaches + 1,
    })
  }, 60000)

  it('rolls back real task writes, outbox completion and receipt when the SQL consumer fails', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    await stageDelivered(f)
    const cut = await checkpointCut(f)
    const consume = f.saver.consumeApprovalInterrupt.bind(f.saver)
    let writes = 0
    const failure = vi.spyOn(f.saver, 'consumeApprovalInterrupt').mockImplementation(async (sql, interaction) => {
      await consume(sql, interaction)
      writes++
      throw new Error('rollback-real-checkpoint')
    })
    const errors: unknown[] = []
    await f.engine.resume(f.f.run.id).catch((error: unknown) => errors.push(error))
    expect(errors).toHaveLength(1)
    expect(writes).toBe(1)
    expect(errors[0]).toMatchObject({ message: 'rollback-real-checkpoint' })
    expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(cut.pendingWrites)
    expect(await f.receipts()).toEqual([])
    expect((await f.db.pool.query("select state from interaction_graph_resumes where run_id=$1", [f.f.run.id])).rows)
      .not.toContainEqual({ state: 'resumed' })
    expect(f.provider.counts.responses).toBe(1)
    failure.mockRestore()
    await expireAbandonedClaims(f)
    await f.engine.resume(f.f.run.id)
    expect(await f.receipts()).toHaveLength(1)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)

  it('retries after COMMIT before graph acknowledgement, without another native response or resume value', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    const cut = await checkpointCut(f)
    const failingSaver = crashAfterCommitSaver(f)
    const [interaction] = await f.pending()
    const result = await f.service.respond({ kind: 'user', principal: f.principal }, response(interaction!))
    expect(result.interaction.deliveryState).toBe('delivered')
    expect(failingSaver.crashed).toBe(true)
    const receipts = await f.receipts()
    const committed = (await f.saver.getTuple(cut.config))?.pendingWrites
    expect(receipts).toHaveLength(1)
    expect(committed?.filter((write) => write[1] === '__resume__')).toHaveLength(1)
    expect((await f.db.pool.query('select state,approval_native_ack_id from interaction_graph_resumes where interaction_id=$1', [interaction!.id])).rows[0])
      .toEqual({ state: 'resumed', approval_native_ack_id: null })
    failingSaver.restore()
    await f.engine.resume(f.f.run.id)
    for (let n = 0; n < 3; n++) await f.engine.resumeInteraction(result.interaction)
    expect(await f.receipts()).toEqual(receipts)
    expect((await f.saver.getTuple(cut.config))?.pendingWrites?.filter((write) => write[1] === '__resume__'))
      .toEqual(committed?.filter((write) => write[1] === '__resume__'))
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)
})
