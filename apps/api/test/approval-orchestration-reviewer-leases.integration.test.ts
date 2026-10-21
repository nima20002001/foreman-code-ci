import { afterEach, describe, expect, it, vi } from 'vitest'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { retainRemoteReviewerCredential } from '../src/modules/interactions/retainedRemoteReviewer.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('current durable approval orchestration', () => {
  it('releases a drained review observer without changing its acknowledged native turn', async () => {
    const f = await approvalDatabase()
    try {
      await expect(f.repository.coordination.transitionReviewJob(f.job.id, f.job.leaseToken!, 'completed', {
        releaseLease: true,
      })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
      await expect(f.repository.coordination.transitionReviewJob(f.job.id, f.job.leaseToken!, 'acknowledged', {
        releaseLease: true, retryAfter: new Date().toISOString(),
      })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
      f.resumeObservation()
      await f.native.reviewers.shutdown()
      const retained = await f.repository.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId)
      expect(retained).toEqual({
        ...f.job, updatedAt: expect.any(String),
        leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
      })
      expect((await f.repository.coordination.getLane(f.job.provider, f.job.nativeSessionId))?.leaseToken)
        .toBeUndefined()
      const successor = await f.repository.coordination.claimReviewJob(f.job.id, 'successor', 'successor-token',
        new Date(Date.now() + 60_000).toISOString())
      await expect(f.repository.coordination.transitionReviewJob(f.job.id, f.job.leaseToken!, f.job.state, {
        releaseLease: true,
      })).rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
      expect(await f.repository.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId)).toEqual(successor)
      const token = f.credential.environment.variables.GRAPHQL_MCP_TOKEN!
      await expect(f.access.authenticate(token, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      const native = (await f.repository.coordination.workflowSession(f.reviewer.id))!
      expect(native).toMatchObject({ finalized: true, reviewerActive: false })
      const bindingBefore = (await f.pool.query(`select approval_review_job_id,approval_review_lease_fence
        from worker_credential_bindings where principal_id=$1`, [f.principal.id])).rows[0]
      expect(bindingBefore.approval_review_job_id).toBe(f.job.id)
      await withExclusiveGraphConnection(f.pool, connection => connection.transaction(sql =>
        retainRemoteReviewerCredential(sql, f.reviewer, {
          generation: '1', principalId: f.principal.id, session: native.session,
        })))
      const app = new PostgresAppInteractionService(f.pool, f.repository, f.commands, f.service)
      const retainedPrincipal = await f.access.authenticate(token, 'worker')
      expect(retainedPrincipal).toEqual(f.principal)
      const retainedSession = await f.repository.coordination.workflowSession(f.reviewer.id)
      expect(retainedSession).toEqual({ ...native, reviewerActive: true })
      await expect(app.respond(retainedPrincipal, approvalResponse(f.interaction)))
        .rejects.toMatchObject({ code: 'REVIEWER_AUTHORITY_LOST' })
      expect(await f.repository.get(f.interaction.id)).toEqual(f.interaction)
      expect(await f.repository.coordination.workflowSession(f.reviewer.id)).toEqual(retainedSession)
      expect(await f.repository.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId)).toEqual(successor)
      const retainedBinding = (await f.pool.query(`select approval_review_job_id,approval_review_lease_fence
        from worker_credential_bindings where principal_id=$1`, [f.principal.id])).rows[0]
      expect(retainedBinding).toEqual({ approval_review_job_id: null, approval_review_lease_fence: null })
      await expect(f.credentials.bindReviewerJob(f.reviewer.id, f.credential, f.job))
        .rejects.toMatchObject({ code: 'REVIEWER_AUTHORITY_LOST' })
      await expect(f.access.authenticate(token, 'worker')).resolves.toEqual(f.principal)
      await expect(app.respond(retainedPrincipal, approvalResponse(f.interaction)))
        .rejects.toMatchObject({ code: 'REVIEWER_AUTHORITY_LOST' })
      await f.credentials.bindReviewerJob(f.reviewer.id, f.credential, successor)
      const rebound = await f.repository.coordination.workflowSession(f.reviewer.id)
      expect(rebound).toEqual({ ...native, reviewerActive: true })
      const recovered = await f.access.authenticate(token, 'worker')
      expect(recovered).toEqual(f.principal)
      const binding = (await f.pool.query(`select approval_review_job_id,approval_review_lease_fence::text
        from worker_credential_bindings where principal_id=$1`, [recovered.id])).rows[0]
      expect(binding).toEqual({
        approval_review_job_id: successor.id, approval_review_lease_fence: expect.any(String),
      })
      await expect(app.respond(recovered, approvalResponse(f.interaction)))
        .rejects.toMatchObject({ code: 'REVIEWER_AUTHORITY_LOST' })
      expect(await f.repository.get(f.interaction.id)).toEqual(f.interaction)
      expect(await f.repository.coordination.workflowSession(f.reviewer.id)).toEqual(rebound)
      expect(await f.repository.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId)).toEqual(successor)
    } finally {
      await f.close()
    }
  }, 50_000)

  it('retains process authentication after repeated observer takeovers without granting a decision lease', async () => {
    const f = await approvalDatabase()
    try {
      const token = f.credential.environment.variables.GRAPHQL_MCP_TOKEN!
      const native = (await f.repository.coordination.workflowSession(f.reviewer.id))!
      const retain = () => withExclusiveGraphConnection(f.pool, connection => connection.transaction(sql =>
        retainRemoteReviewerCredential(sql, f.reviewer, {
          generation: '1', principalId: f.principal.id, session: native.session,
        })))
      await retain()
      expect(await f.access.authenticate(token, 'worker')).toEqual(f.principal)
      f.resumeObservation()
      await f.native.reviewers.shutdown()
      const app = new PostgresAppInteractionService(f.pool, f.repository, f.commands, f.service)
      for (const owner of ['first-observer', 'second-observer']) {
        const job = await f.repository.coordination.claimReviewJob(f.job.id, owner, `${owner}-token`,
          new Date(Date.now() + 60_000).toISOString())
        await expect(f.access.authenticate(token, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
        await retain()
        await retain()
        const recovered = await f.access.authenticate(token, 'worker')
        expect(recovered).toEqual(f.principal)
        await expect(app.respond(recovered, approvalResponse(f.interaction)))
          .rejects.toMatchObject({ code: 'REVIEWER_AUTHORITY_LOST' })
        expect(await f.repository.get(f.interaction.id)).toEqual(f.interaction)
        await f.credentials.bindReviewerJob(f.reviewer.id, f.credential, job)
        await retain()
        expect(await f.access.authenticate(token, 'worker')).toEqual(f.principal)
        await f.repository.coordination.transitionReviewJob(job.id, job.leaseToken!, job.state, { releaseLease: true })
      }
    } finally {
      await f.close()
    }
  }, 50_000)

  it('keeps a busy reviewer pending and gives exactly one contender its durable job lease', async () => {
    const f = await routedApprovalFixture()
    let busyLaneId: string | undefined
    try {
      const workflows = new PostgresWorkflowRepository(f.db.pool)
      const reviewerConfiguration = await workflows.getAgentConfiguration(f.reviewer.agentConfigurationVersionId)
      const requesterConfiguration = await workflows.getAgentConfiguration(f.requester.agentConfigurationVersionId)
      expect(reviewerConfiguration).toMatchObject({
        productRole: 'orchestrator',
        harness: {
          sandbox: 'read-only',
          advanced: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
        },
      })
      expect(requesterConfiguration).toMatchObject({
        productRole: 'coder',
        harness: {
          sandbox: 'read-only',
          advanced: { approvalPolicy: 'on-request', approvalsReviewer: 'user' },
        },
      })
      const lane = (await f.coordination.getLane('codex', f.reviewer.nativeSessionId!))!
      await f.coordination.claimLane(lane.id, lane.revision, f.reviewerId, 'busy-writer', new Date(Date.now() + 60000).toISOString(), 'active-turn')
      busyLaneId = lane.id
      expect(await f.native.reviewers.dispatchNext(f.reviewerId, 'busy-probe')).toMatchObject({ state: 'blocked_busy' })
      expect(f.counts().prompts).toBe(2)
      const blocked = await f.coordination.findReviewJob(f.job.interactionId, f.reviewerId)
      expect(blocked?.retryAfter).toBeDefined()
      const early = await Promise.allSettled(['early-first', 'early-second'].map((owner) =>
        f.coordination.claimReviewJob(f.job.id, owner, `${owner}-token`, new Date(Date.now() + 60000).toISOString())))
      expect(early.every((result) => result.status === 'rejected')).toBe(true)
      await f.db.pool.query(`update review_jobs set record=jsonb_set(record,'{retryAfter}',
        to_jsonb(to_char((clock_timestamp() - interval '1 second') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) where id=$1`, [f.job.id])
      const claims = await Promise.allSettled(['first', 'second'].map((owner) =>
        f.coordination.claimReviewJob(f.job.id, owner, `${owner}-token`,
          new Date(Date.now() + 60000).toISOString())))
      expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1)
    } finally {
      if (busyLaneId) await f.coordination.releaseLane(busyLaneId, 'busy-writer', { observedStatus: 'idle' })
      try {
        await expect(f.engine.shutdown()).resolves.toBeUndefined()
        expect(await f.runs.get(f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
        expect(await f.repository.get(f.interaction.id)).toMatchObject({ status: 'pending' })
        expect(f.counts()).toMatchObject({ prompts: 2, responses: 0 })
      } finally {
        await f.close()
      }
    }
  }, 60000)
})
