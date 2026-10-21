import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { requestReviewFailureStop } from '../src/modules/interactions/reviewFailureLifecycle.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

// Current accepted workflow occurrences and original provider evidence are
// created by the shared fixture. Failure injection occurs at the owned job API.
type Fixture = Awaited<ReturnType<typeof routedApprovalFixture>>
async function fail(f: Fixture, code: string) {
  await f.coordination.claimReviewJob(f.job.id, 'failure-test', 'failure-token', new Date(Date.now() + 60000).toISOString())
  return f.coordination.transitionReviewJob(f.job.id, 'failure-token', 'failed', {
    error: { code, message: 'Private provider diagnostic must not enter public Stop cause.' },
  })
}
afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('current review failure ownership and cleanup', () => {
  it('resolves failure ownership from the exact job, preserves its cause and authenticates persisted readback', async () => {
    const fixtures: Fixture[] = []
    const clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    const errors: unknown[] = []
    try {
      // Separate schemas let the two fixtures migrate and start independently.
      const setup = await Promise.allSettled([routedApprovalFixture(), routedApprovalFixture()])
      const setupErrors: unknown[] = []
      for (const result of setup) {
        if (result.status === 'fulfilled') fixtures.push(result.value)
        else setupErrors.push(result.reason)
      }
      if (setupErrors.length) throw new AggregateError(setupErrors, 'Review failure fixture setup failed.')
      const [f, other] = fixtures as [Fixture, Fixture]
      const commands = new PostgresCommandCoordinator(f.db.pool)
      app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
        operator: { access: f.access, services: { commands, interactions: new OperatorInteractionService(f.service),
          runs: new RunManagementService(f.db.pool, commands, f.runs, f.engine, new WorkspaceLocationService(f.db.pool, commands)) } as never } })
      await fail(f, 'REVIEW_NO_DECISION')
      expect(await requestReviewFailureStop(f.db.pool, { reviewJobId: f.job.id })).toBe(f.run.id)
      const before = await f.runs.get(f.run.id)
      expect(before?.stopCause).toMatchObject({ interactionId: f.interaction.id, reviewJobId: f.job.id, error: { code: 'REVIEW_NO_DECISION' } })
      expect(before?.stopCause?.error.message).not.toContain('Private provider')
      expect((await other.runs.get(other.run.id))?.stopCause).toBeUndefined()
      expect((await f.db.pool.query('select run_id from run_cleanup_intents where pending')).rows).toEqual([{ run_id: f.run.id }])
      const events = (await f.db.pool.query('select run_id from run_activity where payload->>\'reviewJobId\'=$1', [f.job.id])).rows
      expect(events.every((row) => row.run_id === f.run.id)).toBe(true)
      // Repeated recovery is idempotent and cannot replace the original cause.
      await requestReviewFailureStop(f.db.pool, { reviewJobId: f.job.id })
      expect((await f.runs.get(f.run.id))?.stopCause).toEqual(before?.stopCause)
      const reader = await f.access.issue({ name: 'Failure reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['runs:read', 'interactions:read'], scope: { runIds: [f.run.id] } }] })
      const denied = await f.access.issue({ name: 'Other Run reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['runs:read'], scope: { runIds: [other.run.id] } }] })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      async function connect(token: string) {
        const client = new Client({ name: 'review-failure-readback', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const allowed = await connect(reader.token), forbidden = await connect(denied.token)
      const input = { workspaceId: f.run.workspaceId, runId: f.run.id }
      expect((await forbidden.callTool({ name: 'run_get', arguments: input })).isError).toBe(true)
      const read = await allowed.callTool({ name: 'run_get', arguments: input })
      expect(read.isError).not.toBe(true)
      expect(decodeMcpToolResult(read)).toMatchObject({ run: { stopCause: { reviewJobId: f.job.id } }, cleanupPending: true })
      const detail = await allowed.callTool({ name: 'interaction_get', arguments: { interactionId: f.interaction.id } })
      expect(detail.isError).not.toBe(true)
      expect(decodeMcpToolResult(detail)).toMatchObject({ review: { state: 'failed', reviewJobId: f.job.id, cleanupPending: true } })
    } catch (error) {
      errors.push(error)
    }
    await Promise.allSettled(clients.map((c) => c.close()))
    try {
      await app?.close()
    } catch (error) {
      errors.push(error)
    }
    const cleanup = await Promise.allSettled(fixtures.map((fixture) => fixture.close()))
    for (const result of cleanup) {
      if (result.status === 'rejected') errors.push(result.reason)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Review failure test and cleanup failed.')
  }, 60000)

  it.each(['REVIEW_NATIVE_CLOSURE_UNCONFIRMED', 'REVIEW_SUBMISSION_REJECTED'] as const)('%s remains pending across repeated recovery until actual Stop cleanup', async (code) => {
    const f = await routedApprovalFixture()
    try {
      const failed = await fail(f, code)
      expect(failed.cleanup).toMatchObject({ nativeState: 'pending', credentialState: 'pending' })
      expect(failed.cleanup?.completedAt).toBeUndefined()
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await requestReviewFailureStop(f.db.pool, { reviewJobId: f.job.id })).toBe(f.run.id)
        expect((await f.db.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id])).rows[0]).toEqual({ pending: true })
      }
      expect(await f.repository.get(f.interaction.id)).toMatchObject({ status: 'pending', deliveryState: 'not_started' })
      expect(f.counts().responses).toBe(0)
      // A boolean assertion is not native cleanup proof in the current protocol.
      await expect(f.coordination.finishStoppedReviews(f.run.id, true)).rejects.toThrow()
      expect((await f.coordination.findReviewJob(f.interaction.id, f.reviewerId))?.cleanup?.completedAt).toBeUndefined()
      await f.stop()
      await f.engine.cancel(f.run.id)
      expect((await f.runs.get(f.run.id))?.stopCause?.error.code).toBe(code)
      expect((await f.runs.get(f.run.id))?.outcome).toBe('canceled')
    } finally { await f.close() }
  }, 60000)

  it('does not accept nonexistent or nonfailed jobs as Stop authority', async () => {
    const f = await routedApprovalFixture()
    try {
      expect(await requestReviewFailureStop(f.db.pool, { reviewJobId: 'missing' })).toBeUndefined()
      expect(await requestReviewFailureStop(f.db.pool, { reviewJobId: f.job.id })).toBeUndefined()
      expect((await f.db.pool.query('select run_id from run_cleanup_intents where pending')).rows).toHaveLength(0)
      expect((await f.runs.get(f.run.id))?.stopCause).toBeUndefined()
    } finally { await f.close() }
  }, 60000)
})
