import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeSessionReferenceSchema, type HarnessExecution } from '@foreman-code/contracts'
import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import {
  allExecutions, conversationPages, historicalFixture, historicalRows, openHistoricalApi,
  readSelected, readSnapshot, runA, saveWithoutY, sendAndFinish, startSaved, targetFor,
  type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertExactOrigin, chatTarget, rejectedSend, retainedChatRows } from './helpers/historicalRunChat.js'

afterEach(() => vi.restoreAllMocks())

// PostgreSQL and the authenticated transports/services are real. Native providers
// are existing deterministic port fixtures. No additional product/migration mocks
// are introduced; inherited location/native qualification substitutes stay explicit.
describe.skipIf(!postgresEnabled)('Historical Run-scoped chat lifecycle PostgreSQL / HTTP / MCP', () => {
  it('reopens the retained Run database with the original scoped MCP credentials', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      api = await openHistoricalApi(f)
      const snapshot = await readSnapshot(api, targetFor(f))
      const denied = await f.access.issue({ name: 'Historical chat denied scope', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['different-workspace'] } }] })
      const deniedClient = await api.connect(denied.token)
      const deniedRead = await deniedClient.callTool({ name: 'run_board_snapshot_get', arguments: { ...targetFor(f) } })
      expect(deniedRead.isError).toBe(true)
      await api.close()
      api = await openHistoricalApi(f)
      expect(await readSnapshot(api, targetFor(f))).toEqual(snapshot)
      expect(api.native.size).toBe(0)
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)

  it('[SCH-12-C01] removed Y resolves A; shared X never shares a child across Runs; restart/continuation preserve results', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      const [x, y] = f.f.version.definition.nodes
      const executionsA = await allExecutions(f)
      const ax = executionsA.find((execution) => execution.workflowNodeId === x!.id)!
      const ay = executionsA.find((execution) => execution.workflowNodeId === y!.id)!
      const { saved } = await saveWithoutY(f)
      await f.db.pool.query('update agents set archived_at=now() where id=$1', [y!.agentId])
      const b = await startSaved(f, agentWorkflowVersion(saved.version))
      const bx = (await allExecutions(f, b.id)).find((execution) => execution.workflowNodeId === x!.id)!
      expect(ax.nativeSessionId).not.toBe(bx.nativeSessionId)
      const runIds = [f.f.run.id, b.id], before = await historicalRows(f.db.pool, runIds)
      api = await openHistoricalApi(f)
      const snapshotA = await readSnapshot(api, targetFor(f)), snapshotB = await readSnapshot(api, targetFor(f, b.id))
      const automatic = await readSelected(api, chatTarget(api, ay))
      expect(automatic).toMatchObject({ kind: 'selected', key: null,
        selection: { executionId: ay.id }, state: { conversation: null, availability: { canSend: true } } })
      expect(api.native.size).toBe(0)
      expect((await retainedChatRows(api)).conversations).toHaveLength(0)

      const retained: Array<{ execution: HarnessExecution; id: string; marker: string }> = []
      for (const [index, execution] of [ay, ax, bx].entries()) {
        const marker = `SCH-12 transcript ${index}: ${execution.id}`
        const { id, native } = await sendAndFinish(api, chatTarget(api, execution), execution.id,
          null, 'same-request-across-conversations', marker, index % 2 ? 'mcp' : 'http')
        const row = await assertExactOrigin(api, execution, id)
        const source = NativeSessionReferenceSchema.parse((await api.pool.query<{ reference: unknown }>(
          'select reference from execution_native_sessions where execution_id=$1', [execution.id])).rows[0]!.reference)
        expect(native.forks).toHaveLength(1)
        expect(native.forks[0]!.source).toEqual(source)
        expect(row.native_session_id).toBe(native.session.nativeSessionId)
        expect(row.native_session_id).not.toBe(source.nativeSessionId)
        const start = native.forks[0]!.input
        expect(start.kind).toBe('agent-chat')
        if (start.kind !== 'agent-chat') throw new Error('Historical Agent chat must use its conversation owner')
        expect(start.environment).toBeUndefined()
        expect(start).toMatchObject({ conversationId: id, workflowId: f.f.scope.workflowId,
          workflowNodeId: execution.workflowNodeId, configuration: { id: execution.agentConfigurationVersionId } })
        expect('request' in start).toBe(false)
        expect(start.instructionsDelivered).toBe(true)
        retained.push({ execution, id, marker })
      }
      expect(new Set(retained.map((chat) => chat.id)).size).toBe(3)
      expect(new Set([...api.native.values()].map((native) => native.session.nativeSessionId)).size).toBe(3)
      for (const chat of retained) {
        const page = await conversationPages(api, chatTarget(api, chat.execution), chat.execution.id)
        expect(page.history!.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([chat.marker])
        expect(page.receipts!.turns).toHaveLength(1)
        expect(page.receipts!.turns[0]).toMatchObject({ requestId: 'same-request-across-conversations', delivery: 'completed' })
      }
      const own = retained[1]!, other = retained[2]!
      const rowsBeforeDenial = await retainedChatRows(api)
      const promptCount = [...api.native.values()].reduce((count, native) => count + native.prompts.length, 0)
      // Both chats have this requestId already. Wrong expectedConversationId must
      // fail BEFORE receipt replay; another Run's receipt is not acceptance.
      await rejectedSend(api, chatTarget(api, own.execution), own.execution.id, other.id,
        'AGENT_CHAT_CONTEXT_STALE', f.writer.token, api.client, 'same-request-across-conversations', own.marker)
      expect(await retainedChatRows(api)).toEqual(rowsBeforeDenial)
      expect([...api.native.values()].reduce((count, native) => count + native.prompts.length, 0)).toBe(promptCount)
      expect(await historicalRows(f.db.pool, runIds)).toEqual(before)

      const firstApi = api
      await api.close(); api = await openHistoricalApi(f)
      expect(api.pool).not.toBe(firstApi.pool); expect(api.chat).not.toBe(firstApi.chat)
      for (const chat of retained) {
        await assertExactOrigin(api, chat.execution, chat.id)
        const page = await conversationPages(api, chatTarget(api, chat.execution), chat.execution.id)
        expect(page.history!.messages.some((message) => message.content === chat.marker)).toBe(true)
      }
      expect(api.native.size).toBe(0) // readback never attaches/forks/probes
      const historicalY = retained[0]!
      const continued = await sendAndFinish(api, chatTarget(api, ay), ay.id, historicalY.id,
        'continue-after-restart', 'Continue Y in Run A only.', 'mcp')
      expect(continued.id).toBe(historicalY.id)
      expect(continued.native.forks).toHaveLength(0)
      expect(continued.native.attachments).toEqual([continued.native.session])
      expect(continued.native.session.nativeSessionId).not.toBe(ay.nativeSessionId)
      const page = await conversationPages(api, chatTarget(api, ay), ay.id)
      expect(page.history!.messages.filter((message) => message.role === 'user').map((message) => message.content))
        .toEqual([historicalY.marker, 'Continue Y in Run A only.'])
      expect(page.receipts!.turns).toHaveLength(2)
      expect(await readSnapshot(api, targetFor(f))).toEqual(snapshotA)
      expect(await readSnapshot(api, targetFor(f, b.id))).toEqual(snapshotB)
      expect(await historicalRows(f.db.pool, runIds)).toEqual(before)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)
})
