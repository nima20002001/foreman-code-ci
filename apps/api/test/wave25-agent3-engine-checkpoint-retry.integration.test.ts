import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { DomainError } from '../src/modules/errors.js'
import { REPEAT_NATIVE_PENDING_MESSAGE, isSettlementPendingCheckpointError } from '../src/modules/interactions/repeatNativeEvidence.js'
import { readWorkflowCheckpoint } from '../src/modules/runs/repeatGraph.js'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'

/** Actual engine, SQL owners, coordinator, capture and approval services.
 * Only external provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('Current production engine provider wiring', () => {
  afterEach(() => vi.restoreAllMocks())
  it('retries a pending-only checkpoint without native replay or a synthetic approval', async () => {
    const t = await checkpointRuntimeFixture()
    let releaseSettlement: () => void = () => undefined
    try {
      await t.engine.start(t.f.run.id)
      const interaction = (await t.pending())[0]!
      const settle = RepeatRunRepository.prototype.settleNativeExecution
      let pending = true
      const obstruction = vi.spyOn(RepeatRunRepository.prototype, 'settleNativeExecution')
        .mockImplementation(async function (this: RepeatRunRepository, id: string) {
          if (pending && id === interaction.executionId) {
            throw new DomainError('REPEAT_CLEANUP_PENDING', REPEAT_NATIVE_PENDING_MESSAGE, 409)
          }
          return settle.call(this, id)
        })
      releaseSettlement = () => obstruction.mockRestore()
      const cancel = vi.spyOn(t.native, 'cancelRun')
      await t.service.respond({ kind: 'user', principal: t.principal }, approvalResponse(interaction))
      // The callback returns after bounded same-checkpoint retries; it must not
      // wait for a reviewer whose own MCP call could be awaiting this callback.
      const checkpoint = await readWorkflowCheckpoint(t.f.run.id, t.f.version, t.saver)
      expect(checkpoint.tasks.some((task) => isSettlementPendingCheckpointError(task.error))).toBe(true)
      expect((await t.runs.get(t.f.run.id))?.outcome).toBe('pending')
      expect(await t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
      const counts = { ...t.provider.counts }, receipts = await t.receipts()
      expect(receipts).toHaveLength(1)
      pending = false
      // Existing recovery calls start() for this SAME Run/thread, not a new input.
      await t.engine.start(t.f.run.id)
      await expect.poll(async () => (await t.runs.get(t.f.run.id))?.outcome).toBe('succeeded')
      expect(t.provider.counts).toEqual(counts)
      expect(await t.receipts()).toEqual(receipts)
      expect(cancel).not.toHaveBeenCalled()
      await expect.poll(() => t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
    } finally { releaseSettlement(); await t.close() }
  }, 60000)
})
