import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../src/app.js'
import { workerToolServices } from './helpers/workerMcpServices.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { approvalReviewCuts } from './helpers/approvalReviewCuts.js'
import { br1002At } from './helpers/wave25Br1002Cuts.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { rejectableDeferred } from './helpers/deferred.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('current durable approval orchestration', () => {
  it('saves explicit approval policies for the reviewer and requesting worker while retaining read-only sandboxes', async () => {
    const f = await codexApprovalRuntime('orchestrator')
    try {
      const pins = Object.values(f.f.version.agentConfigurationVersionIds)
      const saved = await f.db.pool.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id = any($1::text[])', [pins],
      )
      const configurations = saved.rows.map(row => AgentConfigurationVersionSchema.parse(row.record))
      expect(configurations).toHaveLength(pins.length)
      for (const configuration of configurations) {
        expect(configuration.harness).toMatchObject({
          harness: 'codex', sandbox: 'read-only', advanced: {
            approvalPolicy: 'on-request',
            approvalsReviewer: configuration.productRole === 'orchestrator' ? 'auto_review' : 'user',
            additionalWritableDirectories: [],
          },
        })
      }
      expect((await f.runs.get(f.f.run.id))?.agentConfigurationVersionIds)
        .toEqual(f.f.version.agentConfigurationVersionIds)
    } finally { await f.close() }
  }, 60_000)

  it('delivers an authenticated designated reviewer MCP decision only after exact native review settlement', async () => {
    const f = await routedApprovalFixture()
    const commands = new PostgresCommandCoordinator(f.db.pool)
    const tools = workerToolServices(f.db.pool, commands)
    const { bugReports, ci } = tools
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      appMcp: tools.appMcp(f.access, new PostgresAppInteractionService(f.db.pool, f.repository, commands, f.service)),
      operator: { access: f.access, services: { commands, ci, bugReports, interactions: new OperatorInteractionService(f.service) } as never } })
    const clients: Client[] = []
    const appendHistory = f.coordination.appendReviewNativeHistory.bind(f.coordination)
    const cuts = approvalReviewCuts(f)
    const beforeHistory = rejectableDeferred()
    const afterHistory = rejectableDeferred()
    const publishHistory = rejectableDeferred()
    const finishHistory = rejectableDeferred()
    const historySpy = vi.spyOn(f.coordination, 'appendReviewNativeHistory').mockImplementation(async (...args) => {
      if (!args[1].some((event) => event.type === 'thread.reconciled')) return appendHistory(...args)
      beforeHistory.resolve()
      await publishHistory.promise
      await appendHistory(...args)
      afterHistory.resolve()
      await finishHistory.promise
    })
    let dispatch: Promise<unknown> | undefined
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      async function connect(path: string, token: string) {
        const client = new Client({ name: 'current-approval-proof', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL(path, address), { authProvider: { token: async () => token } }))
        return client
      }
      const reader = await f.access.issue({ name: 'Read approvals', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['interactions:read'], scope: { runIds: [f.run.id] } }] })
      const operator = await connect('/mcp', reader.token)
      const denied = await f.credentials.issueForExecution(f.requester.id)
      const worker = await connect('/mcp', denied.environment.variables.GRAPHQL_MCP_TOKEN!)
      // Neither role lists interaction_respond; a direct call is refused before the decision service.
      for (const [client, code] of [[worker, 'ROLE_NOT_ALLOWED'], [operator, 'ACCESS_DENIED']] as const) {
        const refused = await client.callTool({ name: 'interaction_respond', arguments: approvalResponse(f.interaction) })
        expect(refused.isError).toBe(true)
        const body = refused.content.find((item) => item.type === 'text')
        expect(body?.type).toBe('text')
        expect(JSON.parse(body!.text as string)).toMatchObject({ error: { code } })
      }
      expect(f.counts().responses).toBe(0)
      dispatch = f.native.reviewers.dispatchNext(f.reviewerId, 'current-mcp-proof')
      void dispatch.catch(() => {
        // ignore: br1002At and the awaited dispatch below observe the rejection.
      })
      await br1002At(cuts.started.promise, dispatch)
      const credential = await f.credentials.issueForReviewer(f.reviewer.id)
      const reviewer = await connect('/mcp', credential.environment.variables.GRAPHQL_MCP_TOKEN!)
      const input = approvalResponse(f.interaction)
      const stale = await reviewer.callTool({ name: 'interaction_respond', arguments: { ...input, expectedRevision: 999 } })
      expect(stale.isError).toBe(true)
      expect(f.counts().responses).toBe(0)
      const response = await reviewer.callTool({ name: 'interaction_respond', arguments: input })
      expect(response.isError).not.toBe(true)
      expect(decodeMcpToolResult(response)).toMatchObject({ interaction: { deliveryState: 'pending' } })
      expect(f.counts().responses).toBe(0)
      cuts.continueStart.resolve()
      f.provider.completeReview(f.job.correlationId, f.reviewer.nativeSessionId!)
      await br1002At(cuts.assistant.promise, dispatch)
      cuts.continueAssistant.resolve()
      await br1002At(beforeHistory.promise, dispatch)
      expect(f.counts().responses).toBe(0)
      publishHistory.resolve()
      await br1002At(afterHistory.promise, dispatch)
      finishHistory.resolve()
      await dispatch
      expect((await f.service.recover({ limit: 10 })).errors).toEqual([])
      expect(await f.repository.get(input.interactionId)).toMatchObject({ deliveryState: 'delivered' })
      expect(f.counts().responses).toBe(1)
      expect(decodeMcpToolResult((await operator.callTool({ name: 'interaction_get', arguments: { interactionId: input.interactionId } }))))
        .toMatchObject({ interaction: { deliveryState: 'delivered' } })
      // The provider fixture retains the requester terminal result only in history.
      // Decision and graph resume are durable; Run completion needs later native observation.
      expect((await f.db.pool.query<{ state: string }>(
        'select state from interaction_graph_resumes where interaction_id=$1', [input.interactionId])).rows[0]?.state).toBe('resumed')
      expect((await f.runs.get(f.run.id))?.outcome).toBe('pending')
    } finally {
      cuts.release()
      publishHistory.resolve()
      finishHistory.resolve()
      await dispatch?.catch(() => {
        // ignore: preserve the test failure while closing the clients and runtime.
      })
      cuts.restore()
      historySpy.mockRestore()
      await Promise.allSettled(clients.map((client) => client.close()))
      await app.close()
      await f.close()
    }
  }, 60000)
})
