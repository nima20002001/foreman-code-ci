import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { randomUUID } from 'node:crypto'
import { OperatorToolSchemaResultSchema } from '@foreman-code/contracts/operator-mcp'
import { AgentChatHistoryPageSchema, AgentChatTurnPageSchema, SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { eventually } from './helpers/agentChatF5.js'
import { body, executions, oldRunRows, path, read, setup, terminal } from './sch06-agent-chat.helpers.js'

describe.skipIf(!postgresEnabled)('Selected historical Run chat PostgreSQL / HTTP / MCP', () => {
  it('removed Agent, two Runs, exact child forks, wrong-target receipts, read-only missing sessions, revoked caller, and immutable Run results', async () => {
    const test = await setup(), f = test.f
    try {
      const { workspaceId, workflowId } = f.f.scope
      const y = f.f.version.definition.nodes[1]!
      await f.engine.start(f.f.run.id); await terminal(f, f.f.run.id)
      const a = (await executions(f, f.f.run.id)).find((entry) => entry.workflowNodeId === y.id)!
      expect(a.nativeSessionId).toBeTruthy()
      const location = await f.locations.set(f.writer.principal, 'http', { workspaceId, commandId: randomUUID(),
        expectedLocationRevision: 1, runnerId: f.locations.runnerId, rootPath: f.db.directory })
      const revision = Number((await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [workflowId])).rows[0]!.revision)
      const dispatch = vi.spyOn(f.engine, 'start')
      const started = RunStartV3ResultSchema.parse(body(await f.client.callTool({ name: 'run_start', arguments: {
        workspaceId, workflowId, workflowVersionId: f.f.version.id, executionSemanticsVersion: 3,
        commandId: randomUUID(), expectedWorkflowRevision: revision, expectedLocationRevision: location.value.locationRevision,
        expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds, input: {},
      } })))
      await eventually(() => dispatch.mock.calls.some(([runId]) => runId === started.run.id))
      const dispatchIndex = dispatch.mock.calls.findIndex(([runId]) => runId === started.run.id)
      const dispatched = dispatch.mock.results[dispatchIndex]!
      expect(dispatched.type).toBe('return')
      // Join the MCP dispatch just as the first Run joins its engine call before checking cleanup.
      await dispatched.value
      await terminal(f, started.run.id)
      expect(dispatch.mock.calls.filter(([runId]) => runId === started.run.id)).toHaveLength(1)
      const b = (await executions(f, started.run.id)).find((entry) => entry.workflowNodeId === y.id)!
      const runIds = [a.runId, b.runId]
      const unchanged = await oldRunRows(f, runIds)

      // Remove Y with the same typed current-workflow writer used by the product.
      const graph = structuredClone(f.f.version.definition)
      graph.nodes = graph.nodes.filter((entry) => entry.id !== y.id)
      graph.edges = graph.edges.filter((edge) => edge.source !== y.id && edge.target !== y.id)
      graph.executionPolicy = { maxParallelism: 1, maxNodeExecutions: graph.nodes.length }
      if (graph.requiredAgentCount !== undefined) graph.requiredAgentCount = graph.nodes.length
      const currentRevision = Number((await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [workflowId])).rows[0]!.revision)
      const saved = (await f.services.workflows.current.save(f.writer.principal, 'http', {
        workspaceId, workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: currentRevision, expectedWorkflowVersionId: f.f.version.id,
        expectedAgentConfigurationVersionIds: Object.fromEntries(graph.nodes.map((node) => [node.agentId, f.f.version.agentConfigurationVersionIds[node.agentId]!])), graph,
      })).value
      expect(saved.version.definition.nodes.some((entry) => entry.id === y.id)).toBe(false)
      await f.db.pool.query('update agents set archived_at=now() where id=$1', [y.agentId])
      const targets = [a, b].map((execution) => ({ workspaceId, workflowId, runId: execution.runId, workflowNodeId: y.id }))
      const headers = { authorization: `Bearer ${f.writer.token}` }
      for (const target of targets) {
        const placementScope = { workspaceId, workflowId, runId: target.runId, nodeId: y.id }
        const placementPath = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}`
          + `/runs/${target.runId}/nodes/${y.id}/placement`
        const placement = await test.app.inject({ method: 'GET', url: placementPath, headers })
        expect(placement.statusCode, placement.body).toBe(200)
        expect(placement.json()).toEqual({ ...placementScope,
          readback: { evidence: 'legacy_missing', originalMainInstallationId: null } })
        expect(body(await test.mcp.callTool({ name: 'run_node_placement_get', arguments: placementScope })))
          .toEqual(placement.json())
      }
      const discovery = (await test.mcp.listTools()).tools.find((tool) => tool.name === 'agent_chat_read')!
      expect(discovery.inputSchema.properties?.selection).toBeDefined()
      expect(discovery.inputSchema.properties?.history).toBeDefined()
      expect(discovery.name).toBe('agent_chat_read')
      expect(discovery).not.toHaveProperty('outputSchema')
      const schema = OperatorToolSchemaResultSchema.parse(body(await test.mcp.callTool({
        name: 'operator_tool_schema_get', arguments: { name: 'agent_chat_read', includeOutputSchema: true },
      })))
      expect(schema.name).toBe('agent_chat_read')
      expect(schema.inputSchema).toEqual(discovery.inputSchema)
      expect(schema.outputSchema?.type).toBe('object')
      expect(discovery.annotations?.readOnlyHint).toBe(true)
      expect((await read(test, targets[0]!)).kind).toBe('selected')
      expect(test.native.size).toBe(0)
      const ids: string[] = []
      for (const [index, execution] of [a, b].entries()) {
        const target = targets[index]!
        const message = { requestId: 'same-request-id', content: 'Continue only this historical chat.', expectedConversationId: null }
        const sent = index === 0
          ? await (async () => {
            const response = await test.app.inject({ method: 'POST', url: `${path(target)}/messages`, headers,
              payload: { executionId: execution.id, ...message } })
            expect(response.statusCode, response.body).toBe(202); return response.json()
          })()
          : body(await test.mcp.callTool({ name: 'agent_chat_send', arguments: { workspaceId,
            selection: { workflowId, runId: target.runId, workflowNodeId: y.id, executionId: execution.id }, message } }))
        const id = SendAgentChatMessageResponseSchema.parse(sent).state.conversation!.id; ids.push(id)
        await eventually(() => test.native.get(id)?.prompts.length === 1)
        const native = test.native.get(id)!
        expect(native.forks).toHaveLength(1)
        expect(native.forks[0]!.source.nativeSessionId).toBe(execution.nativeSessionId)
        expect(native.session.nativeSessionId).not.toBe(execution.nativeSessionId)
        const start = native.forks[0]!.input
        expect(start.environment).toBeUndefined()
        expect(start.kind).toBe('agent-chat')
        if (start.kind !== 'agent-chat') throw new Error('Expected the Agent conversation owner')
        expect(start.conversationId).toBe(id)
        expect(start.workflowId).toBe(workflowId)
        expect(start.workflowNodeId).toBe(y.id)
        expect(start.configuration.id).toBe(execution.agentConfigurationVersionId)
        expect('request' in start).toBe(false)
        expect(start.instructionsDelivered).toBe(true)
        // A foreign native receipt must not settle this chat or alter its Run.
        native.wrongReceipt = index === 0
        native.finish({ outcome: 'succeeded', output: { continuedInChat: true } })
        await eventually(async () => (await test.repository.turn(id, message.requestId))?.delivery === (index === 0 ? 'unknown' : 'completed'))
        native.wrongReceipt = false
        if (index === 0) { await test.chat.recover(); await eventually(async () => (await test.repository.turn(id, message.requestId))?.delivery === 'completed') }
        const selected = await read(test, target, execution.id)
        expect(selected).toMatchObject({ kind: 'selected', key: { ...target, agentId: y.agentId, executionId: execution.id, conversationId: id } })
      }
      expect(ids[0]).not.toBe(ids[1])
      const promptCount = [...test.native.values()].reduce((count, native) => count + native.prompts.length, 0)
      // Both conversations have the same requestId/content. This must fail BEFORE replay.
      const wrong = await test.app.inject({ method: 'POST', url: `${path(targets[0]!)}/messages`, headers, payload: {
        executionId: a.id, requestId: 'same-request-id', content: 'Continue only this historical chat.', expectedConversationId: ids[1],
      } })
      expect(wrong.statusCode, wrong.body).toBe(409)
      expect(wrong.json()).toMatchObject({ error: { code: 'AGENT_CHAT_CONTEXT_STALE' } })
      const wrongExecution = await test.app.inject({ method: 'GET', url: `${path(targets[0]!)}?${new URLSearchParams({ executionId: b.id })}`, headers })
      expect(wrongExecution.statusCode).toBe(404)
      const mixedInterrupt = await test.app.inject({ method: 'POST', url: `${path(targets[0]!)}/interrupt`, headers, payload: {
        executionId: a.id, agentId: y.agentId, conversationId: ids[1], requestId: randomUUID(),
      } })
      expect(mixedInterrupt.statusCode).toBe(409)
      expect([...test.native.values()].reduce((count, native) => count + native.prompts.length, 0)).toBe(promptCount)
      expect([...test.native.values()].every((native) => native.cancellations.length === 0)).toBe(true)

      // Same services for steering and interrupt, always against the child, not the Run source.
      await test.chat.sendSelectedRun(f.writer.principal, { selection: { ...targets[0]!, executionId: a.id },
        message: { requestId: 'second-turn', content: 'Second chat-only turn.', expectedConversationId: ids[0] } })
      const nativeA = test.native.get(ids[0]!)!
      await eventually(async () => nativeA.prompts.length === 2
        && (await test.repository.get(ids[0]!))?.active_native_turn_id === nativeA.nativeTurnId)
      await test.chat.sendSelectedRun(f.writer.principal, { selection: { ...targets[0]!, executionId: a.id }, message: {
        requestId: 'steer-child', content: 'Steer only the child.', intent: 'steer', expectedConversationId: ids[0], expectedNativeTurnId: nativeA.nativeTurnId,
      } })
      expect(nativeA.steers).toHaveLength(1)
      const interrupted = body(await test.mcp.callTool({ name: 'agent_chat_interrupt', arguments: { workspaceId,
        conversationId: ids[0], requestId: 'stop-child', expectedNativeTurnId: nativeA.nativeTurnId,
        selection: { workflowId, runId: a.runId, workflowNodeId: y.id, agentId: y.agentId, executionId: a.id },
      } }))
      expect(interrupted).toHaveProperty('state')
      await eventually(async () => (await test.repository.turn(ids[0]!, 'second-turn'))?.delivery === 'canceled')
      expect(nativeA.cancellations[0]?.session).toBe(nativeA.session.nativeSessionId)
      expect(nativeA.cancellations[0]?.session).not.toBe(a.nativeSessionId)

      // Losing a previously bound identity is read-only. Existing transcript/receipt routes stay usable.
      await f.db.pool.query('update operator_conversations set native_session_id=null where id=$1', [ids[0]])
      const missing = await read(test, targets[0]!, a.id)
      expect(missing).toMatchObject({ kind: 'selected', state: { sessionState: 'unavailable',
        availability: { canSend: false, reason: 'native_session_missing' }, capabilities: { resume: false } } })
      const paged = ReadSelectedRunChatResponseSchema.parse(body(await test.mcp.callTool({ name: 'agent_chat_read', arguments: {
        workspaceId, selection: { workflowId, runId: a.runId, workflowNodeId: y.id, executionId: a.id }, history: {}, receipts: {},
      } })))
      if (paged.kind !== 'selected') throw new Error('The retained conversation must stay readable')
      const chatRoot = `/api/workspaces/${workspaceId}/agent-chat/conversations/${ids[0]}`
      const history = await test.app.inject({ method: 'GET', url: `${chatRoot}/history`, headers })
      const receipts = await test.app.inject({ method: 'GET', url: `${chatRoot}/turns`, headers })
      expect(history.statusCode).toBe(200); expect(receipts.statusCode).toBe(200)
      expect(paged.history).toEqual(AgentChatHistoryPageSchema.parse(history.json()))
      expect(paged.receipts).toEqual(AgentChatTurnPageSchema.parse(receipts.json()))
      expect(paged.history!.messages.length).toBeGreaterThan(0)
      expect(paged.receipts!.turns.length).toBeGreaterThan(0)

      const allowed = await f.access.issue({ name: 'SCH-06 read-only', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [workspaceId], workflowIds: [workflowId], runIds: [a.runId] } }] })
      const reader = await test.connect(allowed.token)
      await read(test, targets[0]!, a.id, allowed.token, reader)
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_chat_send')
      const denied = await test.app.inject({ method: 'GET', url: path(targets[1]!), headers: { authorization: `Bearer ${allowed.token}` } })
      expect(denied.statusCode).toBe(403)
      const deniedMcp = await reader.callTool({ name: 'agent_chat_read', arguments: { workspaceId,
        selection: { workflowId, runId: b.runId, workflowNodeId: y.id, executionId: b.id } } })
      expect(deniedMcp.isError).toBe(true); expect(deniedMcp.structuredContent).toBeUndefined()
      await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [allowed.principal.id])
      await expect(test.chat.readSelectedRun(allowed.principal, { selection: { ...targets[0]!, executionId: a.id } }))
        .rejects.toMatchObject({ code: 'AUTH_REVOKED', status: 403 })
      const revoked = await test.app.inject({ method: 'GET', url: path(targets[0]!), headers: { authorization: `Bearer ${allowed.token}` } })
      expect([401, 403]).toContain(revoked.statusCode)
      expect(await oldRunRows(f, runIds)).toEqual(unchanged)
      expect(f.dispatchErrors).toEqual([])
    } finally { await test.close() }
  }, 120000)

})
