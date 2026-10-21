import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import {
  allExecutions, historicalFixture, historicalRows, openHistoricalApi, readSelected, runA,
  selectedPath, sendAndFinish, targetFor, type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { approvalFixture } from './helpers/wave25ApprovalFixture.js'
import { assertExactOrigin, expectProtocolDenial, retainedChatRows } from './helpers/historicalRunChat.js'

afterEach(() => vi.restoreAllMocks())

// PostgreSQL and the authenticated transports/services are real. Native providers
// are existing deterministic port fixtures. No additional product/migration mocks
// are introduced; inherited location/native qualification substitutes stay explicit.
describe.skipIf(!postgresEnabled)('Historical Run-scoped chat repeat PostgreSQL / HTTP / MCP', () => {
  it('reopens a retained repeat Run with its credentials and preserves chat read permissions', async () => {
    const f = await historicalFixture('repeat')
    let api: HistoricalApi | undefined
    try {
      const target = { ...targetFor(f), workflowNodeId: f.f.version.definition.nodes[1]!.id }
      const before = await historicalRows(f.db.pool, [f.f.run.id])
      const denied = await f.access.issue({
        name: 'Unprivileged chat reader',
        audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [],
      })
      api = await openHistoricalApi(f)
      expect(await readSelected(api, target)).toEqual({
        kind: 'unavailable', target, reason: 'execution_missing',
      })
      const deniedClient = await api.connect(denied.token)
      const http = await api.app.inject({
        method: 'GET',
        url: selectedPath(target),
        headers: { authorization: `Bearer ${denied.token}` },
      })
      expect(http.statusCode, http.body).toBe(403)
      expect(http.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const { workspaceId, ...selection } = target
      const mcp = await deniedClient.callTool({
        name: 'agent_chat_read', arguments: { workspaceId, selection },
      })
      expect(mcp.isError).toBe(true)
      expect(mcp.structuredContent).toBeUndefined()
      expect(JSON.stringify(mcp)).toContain('ACCESS_DENIED')
      expect(await historicalRows(api.pool, [f.f.run.id])).toEqual(before)
      expect((await retainedChatRows(api)).conversations).toEqual([])
      expect(api.native.size).toBe(0)
    } finally {
      try { await api?.close() } finally { await f.close() }
    }
  }, 120_000)

  it('real repeat executions require an explicit choice and retain separate conversations/sessions', async () => {
    const f = await historicalFixture('repeat')
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      const y = f.f.version.definition.nodes[1]!
      const all = await allExecutions(f), executions = all.filter((execution) => execution.workflowNodeId === y.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      expect(executions).toHaveLength(3) // three real finite-repeat occurrences, not fabricated SQL attempts
      expect(new Set(executions.map((execution) => execution.nativeSessionId)).size).toBe(1)
      expect(executions.map((execution) => execution.sessionContinuation?.previousExecutionId))
        .toEqual([undefined, executions[0]!.id, executions[1]!.id])
      const before = await historicalRows(f.db.pool, [f.f.run.id])
      api = await openHistoricalApi(f)
      const target = { ...targetFor(f), workflowNodeId: y.id }
      const choice = await readSelected(api, target)
      expect(choice).toMatchObject({ kind: 'execution_selection_required', target, hasMoreExecutions: false })
      if (choice.kind !== 'execution_selection_required') throw new Error('Several executions must never auto-select the latest')
      expect(choice.executions.map((execution) => execution.executionId).sort()).toEqual(executions.map((execution) => execution.id).sort())
      expect(api.native.size).toBe(0)
      const ids: string[] = []
      for (const execution of executions) {
        expect(await readSelected(api, target, execution.id)).toMatchObject({ kind: 'selected', key: null,
          selection: { executionId: execution.id } })
        const { id, native } = await sendAndFinish(api, target, execution.id, null, 'same-request-per-execution',
          `Only execution ${execution.id}`, 'mcp')
        ids.push(id)
        await assertExactOrigin(api, execution, id)
        expect(native.forks[0]!.source.nativeSessionId).toBe(execution.nativeSessionId)
      }
      expect(new Set(ids).size).toBe(3)
      expect(new Set([...api.native.values()].map((native) => native.session.nativeSessionId)).size).toBe(3)
      expect(await readSelected(api, target)).toEqual(choice) // existing chats do not turn ambiguity into "latest"
      const wrongExecution = all.find((execution) => execution.workflowNodeId !== y.id)!
      const headers = { authorization: `Bearer ${f.writer.token}` }
      const { workspaceId, ...selection } = target
      for (const [executionId, status, code] of [
        [wrongExecution.id, 404, 'RUN_CHAT_EXECUTION_NOT_FOUND'],
        [`absent-${randomUUID()}`, 404, 'RUN_CHAT_EXECUTION_NOT_FOUND'],
      ] as const) {
        const http = await api.app.inject({ method: 'GET', url: `${selectedPath(target)}?${new URLSearchParams({ executionId })}`, headers })
        expect(http.statusCode, http.body).toBe(status)
        expect(http.json()).toMatchObject({ error: { code } })
        const wrong = await api.client.callTool({ name: 'agent_chat_read', arguments: {
          workspaceId, selection: { ...selection, executionId },
        } })
        expect(wrong.isError).toBe(true); expect(wrong.structuredContent).toBeUndefined()
        expect(JSON.stringify(wrong)).toContain(code)
      }
      const missing = await api.app.inject({ method: 'POST', url: `${selectedPath(target)}/messages`, headers,
        payload: { requestId: randomUUID(), content: 'Do not choose an execution for me.', expectedConversationId: null } })
      expect(missing.statusCode, missing.body).toBe(400)
      await expectProtocolDenial(() => api!.client.callTool({ name: 'agent_chat_send', arguments: {
        workspaceId, selection, message: { requestId: randomUUID(), content: 'Do not choose for me.', expectedConversationId: null },
      } }))
      expect((await retainedChatRows(api)).conversations).toHaveLength(3)
      expect([...api.native.values()].every((native) => native.prompts.length === 1 && native.forks.length === 1)).toBe(true)
      expect(await historicalRows(f.db.pool, [f.f.run.id])).toEqual(before)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)

  it('routed workflow rejects an ephemeral Codex configuration before admission', async () => {
    const db = await agent3Database()
    try {
      const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
      const harness = approvalFixture().configurations[1]!.harness
      if (harness.harness !== 'codex') throw new Error('Routed approval fixture requires Codex')
      fixture.configurations = fixture.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({
        ...configuration,
        harness: { ...harness, advanced: { ...harness.advanced!, sessionPersistence: 'ephemeral' } },
      }))
      // Seed calls the production Save service without the runtime fixture's harness normalization.
      await expect(seedAgent3(db.pool, db.directory, fixture)).rejects.toMatchObject({
        code: 'WORKFLOW_HARNESS_APPROVAL_CONFLICT',
        status: 409,
        message: expect.stringContaining('Routed approval requires a persistent Codex session'),
      })
      for (const configuration of fixture.configurations) {
        const stored = (await db.pool.query<{ record: unknown }>(
          'select record from agent_configuration_versions where id=$1', [configuration.id])).rows[0]!
        expect(AgentConfigurationVersionSchema.parse(stored.record).harness).toMatchObject({
          harness: 'codex', advanced: { approvalPolicy: 'on-request', sessionPersistence: 'ephemeral' },
        })
      }
      expect((await db.pool.query('select id from workflow_versions')).rows).toEqual([])
      expect((await db.pool.query('select id from runs')).rows).toEqual([])
      expect((await db.pool.query('select id from harness_executions')).rows).toEqual([])
    } finally {
      await db.close()
    }
  }, 120_000)
})
