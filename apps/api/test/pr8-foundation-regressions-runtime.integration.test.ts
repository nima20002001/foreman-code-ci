import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent3Database, candidateFor, postgresEnabled } from './helpers/wave25Agent3.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('PostgreSQL scheduling and approval recovery', () => {
  it('atomically schedules one current occurrence and event, rolls back failed publication, and retries exactly once', async () => {
    const db = await agent3Database()
    try {
      const f = await currentRepositoryFixture(db)
      const owner = (await f.repository.acquireOwnership(f.f.run.id, () => undefined))!
      try {
        await db.pool.query(`create function reject_schedule() returns trigger language plpgsql as $$
          begin if NEW.effect_kind='input.bind' then raise exception 'injected graph publication failure'; end if; return NEW; end $$;
          create trigger fail_schedule before insert on run_graph_effects for each row execute function reject_schedule()`)
        const admit = () => f.repository.admitRepeatExecution({ nodeId: f.f.version.entryNodeId, occurrence: null }, () => candidateFor(f.f), owner)
        await expect(admit()).rejects.toThrow('injected graph publication failure')
        expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toHaveLength(0)
        expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='input.bind'", [f.f.run.id])).rows).toHaveLength(0)
        await db.pool.query('drop trigger fail_schedule on run_graph_effects')
        const first = await admit(), replay = await admit()
        expect(replay).toEqual({ ...first, reused: true })
        expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toHaveLength(1)
        expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='input.bind'", [f.f.run.id])).rows).toHaveLength(1)
      } finally { await owner.release() }
    } finally { await db.close() }
  }, 60000)

  it('rejects conflicting interaction scope and fabricated delivery transitions, then recovers the actual native delivery', async () => {
    const f = await checkpointRuntimeFixture()
    try {
      await f.engine.start(f.f.run.id)
      const [interaction] = await f.pending()
      for (const field of ['workspaceId', 'workflowId', 'runId', 'executionId', 'requestingAgentId'] as const) {
        await expect(f.repository.create({ ...interaction!, id: randomUUID(), [field]: `different-${field}` })).rejects.toThrow()
      }
      await expect(f.repository.updateDelivery(interaction!.id, interaction!.revision, 'delivered')).rejects.toThrow()
      expect(await f.repository.get(interaction!.id)).toMatchObject({ status: 'pending', deliveryState: 'not_started' })
      const result = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction!))
      expect(result.interaction.deliveryState).toBe('delivered')
      expect(f.provider.counts.responses).toBe(1)
      expect((await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction!))).replayed).toBe(true)
      expect(f.provider.counts.responses).toBe(1)
    } finally { await f.close() }
  }, 60000)

  it('rejects invalid review leases without mutation, recovers expired ownership, and fences the old owner', async () => {
    const f = await routedApprovalFixture()
    try {
      const before = (await f.db.pool.query('select revision,record from review_jobs where id=$1', [f.job.id])).rows
      for (const [owner, token, expiry] of [['', 'token', '2099-01-01T00:00:00Z'], ['owner', '', '2099-01-01T00:00:00Z'],
        ['owner', 'token', 'invalid'], ['owner', 'token', '2000-01-01T00:00:00Z']]) {
        await expect(f.coordination.claimReviewJob(f.job.id, owner!, token!, expiry!)).rejects.toThrow()
      }
      expect((await f.db.pool.query('select revision,record from review_jobs where id=$1', [f.job.id])).rows).toEqual(before)
      const expiry = new Date(Date.now() + 60000).toISOString()
      const first = await f.coordination.claimReviewJob(f.job.id, 'old', 'old-token', expiry)
      await f.db.pool.query("update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id=$1", [f.job.id])
      const next = await f.coordination.claimReviewJob(f.job.id, 'new', 'new-token', expiry)
      expect(next.attempt).toBe(first.attempt + 1)
      await expect(f.coordination.transitionReviewJob(f.job.id, 'old-token', 'failed', { error: { code: 'TEST', message: 'test' } }))
        .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
      expect(await f.coordination.findReviewJob(f.interaction.id, f.reviewerId)).toMatchObject({ leaseOwner: 'new', leaseToken: 'new-token' })
    } finally { await f.close() }
  }, 60000)
})
