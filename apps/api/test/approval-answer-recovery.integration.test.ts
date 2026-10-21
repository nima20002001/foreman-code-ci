import { describe, expect, it, vi } from 'vitest'
import { approvalFaultFixture, approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { restartCleanup } from './workflowApprovalRestart.test-support.js'

const closes = restartCleanup()

describe.skipIf(!postgresEnabled)('recorded workflow approval answers', () => {
  it('finishes a delivered answer after Main restarts before checkpoint consumption, without resending it', async () => {
    const t = await approvalFaultFixture('ordinary')
    closes.push(t.close)
    await t.runtime.engine.start(t.runId)
    const pending = await t.onePending()
    vi.spyOn(t.runtime.engine, 'resumeInteraction')
      .mockRejectedValueOnce(new Error('Main stopped before checkpoint consumption'))
    const answered = await t.runtime.service.respond(t.responder, approvalResponse(pending))
    expect(answered.interaction).toMatchObject({ id: pending.id, status: 'delivered', deliveryState: 'delivered' })
    expect(t.faults.responseWrites).toHaveLength(1)

    await t.restart()
    await t.runtime.engine.start(t.runId)
    await vi.waitFor(async () => {
      expect(await t.runtime.runs.get(t.runId)).toMatchObject({ executionState: 'completed' })
    }, { timeout: 30_000, interval: 10 })
    await t.settled('succeeded')
    expect(t.faults.responseWrites).toHaveLength(1)
    expect(await t.runtime.repository.get(pending.id)).toMatchObject({ status: 'delivered', deliveryState: 'delivered' })
    expect(await t.resumeRows(pending.id)).toEqual([expect.objectContaining({ state: 'resumed' })])
  }, 90_000)

  it('retries an answer whose requester attachment failed before native dispatch once recovery runs again', async () => {
    const t = await approvalFaultFixture('ordinary')
    closes.push(t.close)
    await t.runtime.engine.start(t.runId)
    const pending = await t.onePending()
    vi.spyOn(t.runtime.native, 'attachInteraction')
      .mockRejectedValueOnce(new Error('Worker link lost before attachment'))
    const answered = await t.runtime.service.respond(t.responder, approvalResponse(pending))
    expect(answered.interaction).toMatchObject({ status: 'delivery_failed', deliveryState: 'failed' })
    expect(t.faults.responseWrites).toHaveLength(0)

    expect((await t.runtime.service.recover({ limit: 20 })).errors).toEqual([])
    expect(await t.runtime.repository.get(pending.id)).toMatchObject({ status: 'delivered', deliveryState: 'delivered' })
    expect(t.faults.responseWrites).toHaveLength(1)
    await vi.waitFor(async () => {
      expect(await t.runtime.runs.get(t.runId)).toMatchObject({ executionState: 'completed' })
    }, { timeout: 30_000, interval: 10 })
    await t.settled('succeeded')
    await t.runtime.service.recover({ limit: 20 })
    expect(t.faults.responseWrites).toHaveLength(1)
  }, 90_000)
})
