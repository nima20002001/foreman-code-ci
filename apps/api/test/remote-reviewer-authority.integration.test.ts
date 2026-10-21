import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { assertRemoteReviewAssignment } from '../src/modules/placement/remoteReviewerAuthority.js'
import { buildApp } from '../src/app.js'
import { workerToolServices } from './helpers/workerMcpServices.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/approvalResponse.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('reviewer assignment and authenticated decision grants', () => {
  it('requires the current job lease, original session, writer lane and immutable approval route', async () => {
    const f = await routedApprovalFixture()
    try {
      const job = await f.coordination.claimReviewJob(f.job.id, 'review-owner', randomUUID(),
        new Date(Date.now() + 60_000).toISOString())
      const reference = (await f.coordination.workflowSession(f.reviewer.id))!.session
      const lane = (await f.coordination.getLane(job.provider, job.nativeSessionId))!
      const token = randomUUID()
      await f.coordination.claimLane(lane.id, lane.revision, 'review-writer', token,
        new Date(Date.now() + 60_000).toISOString(), job.correlationId)
      const intent = DispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1, mainId: randomUUID(),
        runId: f.run.id, nodeId: f.reviewer.workflowNodeId, executionId: f.reviewer.id,
        occurrenceId: null, occurrenceIndex: 0, technicalAttempt: f.reviewer.attempt,
        operationId: randomUUID(), attemptId: randomUUID(), owner: { grantId: randomUUID(), epoch: '1' },
        bindingHash: 'a'.repeat(64), inputDigest: `sha256:${'b'.repeat(64)}` })
      const review = { jobId: job.id, interactionId: job.interactionId, reviewerAgentId: job.reviewerAgentId,
        correlationId: job.correlationId, session: reference, leaseToken: job.leaseToken! }
      await expect(assertRemoteReviewAssignment(f.db.pool, intent, review))
        .rejects.toMatchObject({ code: 'REMOTE_REVIEWER_DENIED' })
      await f.coordination.bindLaneTurn({ id: lane.id, token }, job.correlationId)
      await expect(assertRemoteReviewAssignment(f.db.pool, intent, review)).resolves.toBeUndefined()
      for (const wrong of [
        { ...review, leaseToken: randomUUID() }, { ...review, correlationId: `execution:${f.reviewer.id}` },
        { ...review, session: { ...reference, nativeSessionId: f.requester.nativeSessionId! } },
        { ...review, reviewerAgentId: f.requester.agentId },
      ]) await expect(assertRemoteReviewAssignment(f.db.pool, intent, wrong)).rejects.toMatchObject({ code: 'REMOTE_REVIEWER_DENIED' })
      await f.coordination.releaseLane(lane.id, token, { observedStatus: 'idle' })
      await expect(assertRemoteReviewAssignment(f.db.pool, intent, review)).rejects.toMatchObject({ code: 'REMOTE_REVIEWER_DENIED' })
      expect((await f.repository.get(f.interaction.id))?.deliveryState).toBe('not_started')
      expect(f.counts().responses).toBe(0)
    } finally { await f.close() }
  }, 60_000)

  it('denies read-only and requester MCP decisions without changing the pending interaction', async () => {
    const f = await routedApprovalFixture()
    const commands = new PostgresCommandCoordinator(f.db.pool)
    const tools = workerToolServices(f.db.pool, commands)
    const { bugReports, ci } = tools
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      appMcp: tools.appMcp(f.access, new PostgresAppInteractionService(f.db.pool, f.repository, commands, f.service)),
      operator: { access: f.access, services: { commands, ci, bugReports, interactions: new OperatorInteractionService(f.service) } as never } })
    const clients: Client[] = []
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 })
      const reader = await f.access.issue({ name: 'Approval reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['interactions:read'], scope: { runIds: [f.run.id] } }] })
      const requester = await f.credentials.issueForExecution(f.requester.id)
      const before = await f.repository.get(f.interaction.id)
      for (const [token, code] of [
        [reader.token, 'ACCESS_DENIED'],
        [requester.environment.variables.GRAPHQL_MCP_TOKEN!, 'ROLE_NOT_ALLOWED'],
      ] as const) {
        const client = new Client({ name: 'review-scope-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { authProvider: { token: async () => token } }))
        expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('interaction_respond')
        const denied = await client.callTool({ name: 'interaction_respond', arguments: approvalResponse(f.interaction) })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied.content)).toContain(code)
      }
      expect(await f.repository.get(f.interaction.id)).toEqual(before)
      expect(f.counts().responses).toBe(0)
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
      await f.close()
    }
  }, 60_000)
})
