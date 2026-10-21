import { expect, vi } from 'vitest'
import { RepeatGraphBatchV3Schema } from '@foreman-code/contracts/wave25'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'
import { approvalResponse } from './approvalResponse.js'
import { DomainError } from '../../src/modules/errors.js'
import { REPEAT_NATIVE_PENDING_MESSAGE, isSettlementPendingCheckpointError } from '../../src/modules/interactions/repeatNativeEvidence.js'
import { readWorkflowCheckpoint } from '../../src/modules/runs/repeatGraph.js'
import { RepeatRunRepository } from '../../src/modules/runs/repeatPostgres.js'

export async function executeApprovalBranches(branches: 1 | 2) {
  const t = await checkpointRuntimeFixture(branches)
  try {
    await t.engine.start(t.f.run.id)
    expect((await t.runs.get(t.f.run.id))?.executionState).toBe('waiting')
    const pending = await t.pending()
    expect(pending).toHaveLength(branches)
    for (const interaction of pending) await t.service.respond({ kind: 'user', principal: t.principal }, approvalResponse(interaction))
    await expect.poll(async () => (await t.runs.get(t.f.run.id))?.outcome).toBe('succeeded')
    expect(t.provider.counts).toMatchObject({ sessions: branches + 1, starts: branches + 1, responses: branches })
    const effects = await t.db.pool.query<{ effect_kind: string; count: string }>(
      'select effect_kind,count(*)::text as count from run_graph_effects where run_id=$1 group by effect_kind', [t.f.run.id])
    expect(Object.fromEntries(effects.rows.map((row) => [row.effect_kind, Number(row.count)])))
      .toMatchObject({ 'execution.launch': branches + 1, 'result.accept': branches + 1, 'graph.resume': branches })
    const resumes = await t.db.pool.query<{ state: string; approval_native_ack_id: string | null }>(
      'select state,approval_native_ack_id from interaction_graph_resumes where run_id=$1', [t.f.run.id])
    expect(resumes.rows).toHaveLength(branches)
    expect(resumes.rows.every((row) => row.state === 'resumed' && row.approval_native_ack_id)).toBe(true)
    await expect.poll(() => t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
    const bodies = await t.db.pool.query<{ payload: string }>("select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [t.f.run.id])
    expect(bodies.rows.flatMap((row) => RepeatGraphBatchV3Schema.parse(JSON.parse(row.payload)).events)
      .some((event) => event.fact.type === 'repeat.run.state' && event.fact.state.executionState === 'completed')).toBe(true)
  } finally { await t.close() }
}

export async function preservePendingSibling(finish: 'resume' | 'stop') {
  const t = await checkpointRuntimeFixture(2)
  let releaseSettlement: () => void = () => undefined
  try {
    await t.engine.start(t.f.run.id)
    const [first, sibling] = await t.pending()
    if (!first || !sibling) throw new Error('Two original native approval waits are required')
    const originalSibling = await t.runs.getExecution(sibling.executionId)
    const observe = vi.spyOn(t.native, 'observeExact')
    const cancel = vi.spyOn(t.native, 'cancelRun')
    // Fault only the settlement boundary AFTER a real terminal/ACK commits.
    // No proof, response, native closure or accepted result is fabricated.
    const settle = RepeatRunRepository.prototype.settleNativeExecution
    const obstruction = vi.spyOn(RepeatRunRepository.prototype, 'settleNativeExecution')
      .mockImplementation(async function (this: RepeatRunRepository, id: string) {
        if (id === first.executionId && t.provider.counts.responses === 1) {
          throw new DomainError('REPEAT_CLEANUP_PENDING', REPEAT_NATIVE_PENDING_MESSAGE, 409)
        }
        return settle.call(this, id)
      })
    releaseSettlement = () => obstruction.mockRestore()
    await t.service.respond({ kind: 'user', principal: t.principal }, approvalResponse(first))
    expect((await t.runs.getExecution(first.executionId))?.state).toBe('completed')
    const checkpoint = await readWorkflowCheckpoint(t.f.run.id, t.f.version, t.saver)
    expect(checkpoint.tasks.some((task) => isSettlementPendingCheckpointError(task.error))).toBe(true)
    expect(checkpoint.tasks.some((task) => task.interrupts?.length)).toBe(true)
    // Most importantly, replaying the shared checkpoint did not enter the
    // unconsumed branch's coordinator, restart its budget or replace its native lifetime.
    expect(observe.mock.calls.some(([input]) => input.execution.id === sibling.executionId)).toBe(false)
    expect(await t.runs.getExecution(sibling.executionId)).toEqual(originalSibling)
    const resources = await t.db.pool.query<{ credential_live: boolean; active: boolean; waiting: boolean }>(`
      select exists(select 1 from worker_credential_bindings b join management_principals p on p.id=b.principal_id
        where b.execution_id=$1 and b.revoked_at is null and p.revoked_at is null) as credential_live,
        a.active_started_at is not null as active,a.approval_wait_started_at is not null as waiting
      from approval_execution_state a where a.execution_id=$1`, [sibling.executionId])
    expect(resources.rows).toEqual([{ credential_live: true, active: false, waiting: true }])
    expect(cancel).not.toHaveBeenCalled()
    expect(await t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
    if (finish === 'stop') {
      releaseSettlement()
      await t.stop()
      expect(await t.engine.cancel(t.f.run.id)).toBe(true)
      expect((await t.runs.get(t.f.run.id))?.outcome).toBe('canceled')
      expect((await t.runs.getExecution(first.executionId))?.result?.outcome).toBe('succeeded')
      expect((await t.runs.getExecution(sibling.executionId))?.result?.outcome).toBe('canceled')
      expect(t.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 1 })
    } else {
      // Inspect the live delivered-but-not-consumed window without replacing
      // its actual claim consumer. It still needs the original native lifetime.
      const resume = t.engine.resumeInteraction.bind(t.engine)
      let checkedDelivered = false
      vi.spyOn(t.engine, 'resumeInteraction').mockImplementation(async (interaction, claim) => {
        if (interaction.id === sibling.id) {
          expect(interaction.deliveryState).toBe('delivered')
          const row = (await t.db.pool.query<{ approval_native_ack_id: string | null; consumed: boolean; live: boolean }>(`
            select g.approval_native_ack_id,exists(select 1 from run_graph_effects f where f.run_id=g.run_id
              and f.effect_kind='graph.resume' and f.entity_id=g.interaction_id) as consumed,
              exists(select 1 from worker_credential_bindings b join management_principals p on p.id=b.principal_id
                where b.execution_id=$2 and b.revoked_at is null and p.revoked_at is null) as live
            from interaction_graph_resumes g where g.interaction_id=$1`, [sibling.id, sibling.executionId])).rows[0]
          expect(row).toEqual({ approval_native_ack_id: null, consumed: false, live: true })
          checkedDelivered = true
        }
        return resume(interaction, claim)
      })
      await t.service.respond({ kind: 'user', principal: t.principal }, approvalResponse(sibling))
      expect(checkedDelivered).toBe(true)
      await expect.poll(async () => (await t.runs.get(t.f.run.id))?.outcome).toBe('succeeded')
      const resumes = await t.db.pool.query<{ state: string; approval_native_ack_id: string | null }>(
        'select state,approval_native_ack_id from interaction_graph_resumes where run_id=$1', [t.f.run.id])
      expect(resumes.rows).toHaveLength(2)
      expect(resumes.rows.every((row) => row.state === 'resumed' && row.approval_native_ack_id)).toBe(true)
      expect(await t.receipts()).toHaveLength(2)
      const receipts = await t.receipts()
      const counts = { ...t.provider.counts }
      await t.engine.start(t.f.run.id)
      expect(await t.receipts()).toEqual(receipts)
      expect(t.provider.counts).toEqual(counts)
      expect(counts).toMatchObject({ sessions: 3, starts: 3, responses: 2, attaches: 0 })
      expect(cancel).not.toHaveBeenCalled()
    }
    await expect.poll(() => t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
  } finally { releaseSettlement(); await t.close() }
}
