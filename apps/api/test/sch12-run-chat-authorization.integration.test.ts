import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import {
  allExecutions, conversationPages, historicalFixture, historicalRows, openHistoricalApi, qualifyLocation,
  readSelected, runA, selectedPath, sendAndFinish, startSaved, type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { chatTarget, expectProtocolDenial, retainedChatRows } from './helpers/historicalRunChat.js'

afterEach(() => vi.restoreAllMocks())

// PostgreSQL and the authenticated transports/services are real. Native providers
// are existing deterministic port fixtures. No additional product/migration mocks
// are introduced; inherited location/native qualification substitutes stay explicit.
describe.skipIf(!postgresEnabled)('Historical Run-scoped chat authorization PostgreSQL / HTTP / MCP', () => {
  it('[SCH-12-C04] forged/foreign Runs and Run-limited/revoked callers cannot read or mutate another historical chat', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f); await qualifyLocation(f)
      const b = await startSaved(f)
      const ax = (await allExecutions(f))[0]!, bx = (await allExecutions(f, b.id)).find((entry) => entry.workflowNodeId === ax.workflowNodeId)!
      const foreign = await seedAgent3(f.db.pool, f.db.directory, makeCurrentWorkflowFixture(randomUUID()), { run: true })
      api = await openHistoricalApi(f)
      const aTarget = chatTarget(api, ax), bTarget = chatTarget(api, bx)
      const own = await sendAndFinish(api, aTarget, ax.id, null, 'authorized-message', 'Run A retained text.')
      const other = await sendAndFinish(api, bTarget, bx.id, null, 'authorized-message', 'Run B private text.', 'mcp')
      const limited = await api.access.issue({ name: 'SCH-12 Run A reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [aTarget.workspaceId], workflowIds: [aTarget.workflowId], runIds: [aTarget.runId] } }] })
      const limitedClient = await api.connect(limited.token)
      await readSelected(api, aTarget, ax.id, limited.token, limitedClient)
      expect((await limitedClient.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_chat_send')
      const scoped = await api.access.issue({ name: 'SCH-12 workflow reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [aTarget.workspaceId], workflowIds: [aTarget.workflowId] } }] })
      const scopedClient = await api.connect(scoped.token)
      const runIds = [aTarget.runId, bTarget.runId, foreign.run.id]
      const before = await historicalRows(f.db.pool, runIds), chatBefore = await retainedChatRows(api)
      const pagesA = await conversationPages(api, aTarget, ax.id), pagesB = await conversationPages(api, bTarget, bx.id)
      for (const [target, status, token, client] of [
        [bTarget, 403, limited.token, limitedClient],
        [{ ...aTarget, runId: `forged-${randomUUID()}` }, 404, scoped.token, scopedClient],
        [{ ...aTarget, runId: foreign.run.id }, 404, scoped.token, scopedClient],
        [{ workspaceId: foreign.scope.workspaceId, workflowId: foreign.scope.workflowId, runId: foreign.run.id,
          workflowNodeId: foreign.version.entryNodeId }, 403, scoped.token, scopedClient],
      ] as const) {
        const http = await api.app.inject({ method: 'GET', url: selectedPath(target), headers: { authorization: `Bearer ${token}` } })
        expect(http.statusCode, http.body).toBe(status)
        const { workspaceId, ...selection } = target
        const denied = await client.callTool({ name: 'agent_chat_read', arguments: { workspaceId, selection } })
        expect(denied.isError).toBe(true); expect(denied.structuredContent).toBeUndefined()
        expect(JSON.stringify(denied)).toContain(http.json<{ error: { code: string } }>().error.code)
      }
      // Check a denied write at the HTTP boundary; MCP must not expose the tool.
      const deniedSend = await api.app.inject({ method: 'POST', url: `${selectedPath(aTarget)}/messages`,
        headers: { authorization: `Bearer ${limited.token}` }, payload: {
          executionId: ax.id, expectedConversationId: own.id, requestId: randomUUID(), content: 'Read-only principal must not send.',
        } })
      expect(deniedSend.statusCode, deniedSend.body).toBe(403)
      await expectProtocolDenial(() => limitedClient.callTool({ name: 'agent_chat_send', arguments: {
        workspaceId: aTarget.workspaceId, selection: { workflowId: aTarget.workflowId, runId: aTarget.runId,
          workflowNodeId: aTarget.workflowNodeId, executionId: ax.id },
        message: { expectedConversationId: own.id, requestId: randomUUID(), content: 'Read-only principal must not send.' },
      } }))
      expect(await retainedChatRows(api)).toEqual(chatBefore)
      expect((await conversationPages(api, aTarget, ax.id)).history).toEqual(pagesA.history)
      expect((await conversationPages(api, aTarget, ax.id)).receipts).toEqual(pagesA.receipts)
      expect((await conversationPages(api, bTarget, bx.id)).history).toEqual(pagesB.history)
      expect((await conversationPages(api, bTarget, bx.id)).receipts).toEqual(pagesB.receipts)
      expect(own.native.prompts).toHaveLength(1); expect(other.native.prompts).toHaveLength(1)
      expect(api.native.size).toBe(2)
      // Use the already-connected MCP client after live revocation, not a newly
      // authenticated connection which would test only credential startup.
      await api.pool.query('update management_principals set revoked_at=now() where id=$1', [scoped.principal.id])
      await expect(api.chat.readSelectedRun(scoped.principal, { selection: { ...aTarget, executionId: ax.id } }))
        .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      const revokedHttp = await api.app.inject({ method: 'GET', url: selectedPath(aTarget), headers: { authorization: `Bearer ${scoped.token}` } })
      expect([401, 403]).toContain(revokedHttp.statusCode)
      // Authentication middleware may reject the transport or return an MCP
      // error. Either must be denial, never a successful transcript response.
      let rejectedAtTransport = false
      let revokedResult: Awaited<ReturnType<typeof scopedClient.callTool>> | undefined
      try {
        revokedResult = await scopedClient.callTool({ name: 'agent_chat_read', arguments: {
          workspaceId: aTarget.workspaceId, selection: { workflowId: aTarget.workflowId, runId: aTarget.runId,
            workflowNodeId: aTarget.workflowNodeId, executionId: ax.id },
        } })
      } catch (error) {
        rejectedAtTransport = true
        expect(String(error)).toMatch(/401|403|AUTH_REVOKED|Unauthorized|Forbidden/i)
      }
      if (!rejectedAtTransport) {
        expect(revokedResult).toBeDefined()
        expect(revokedResult!.isError).toBe(true); expect(revokedResult!.structuredContent).toBeUndefined()
      }
      expect(await retainedChatRows(api)).toEqual(chatBefore)
      expect(await historicalRows(f.db.pool, runIds)).toEqual(before)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)
})
