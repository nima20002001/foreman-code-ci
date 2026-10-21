import { describe, expect, it } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/approvalResponse.js'

/** Actual current engine, PostgreSQL approvals and LangGraph checkpoints with a
 * deterministic external provider. No caller JSON creates native evidence. */
describe.skipIf(!postgresEnabled)('current approval node checkpoint re-entry', () => {
  it('consumes delivered resumes without replaying the predecessor or original native turn', async () => {
    const f = await checkpointRuntimeFixture()
    try {
      await f.engine.start(f.f.run.id)
      const [pending] = await f.pending()
      expect(pending?.graphInterruptId).toBeTruthy()
      expect((await f.runs.get(f.f.run.id))?.executionState).toBe('waiting')
      const delivered = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending!))
      expect(delivered.interaction.deliveryState).toBe('delivered')
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      const counts = { ...f.provider.counts }, receipts = await f.receipts()
      await f.engine.resumeInteraction(delivered.interaction)
      expect(f.provider.counts).toEqual(counts)
      expect(await f.receipts()).toEqual(receipts)
      expect(new Set(f.provider.startedNodes).size).toBe(2)
    } finally { await f.close() }
  }, 60000)

  it('binds simultaneous asks to one checkpoint and permits the second request to settle first', async () => {
    const f = await checkpointRuntimeFixture(1, 2)
    try {
      await f.engine.start(f.f.run.id)
      const [first, second] = await f.pending()
      expect(first?.graphInterruptId).toBeTruthy()
      expect(second?.graphInterruptId).toBe(first?.graphInterruptId)
      const response = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(second!))
      expect(response.interaction.deliveryState).toBe('delivered')
      expect((await f.runs.get(f.f.run.id))?.executionState).toBe('waiting')
      const current = await f.repository.get(first!.id)
      expect(current?.status).toBe('pending')
      await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(current!))
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 2 })
    } finally { await f.close() }
  }, 60000)
})
