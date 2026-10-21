import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { randomUUID } from 'node:crypto'
import { SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { eventually } from './helpers/agentChatF5.js'
import { withChatReadClock } from './helpers/chatReadClock.js'
import { body, executions, oldRunRows, read, setup, terminal, dispatchScheduledRun } from './sch06-agent-chat.helpers.js'

describe.skipIf(!postgresEnabled)('Selected Run chat PostgreSQL / HTTP / MCP', () => {
  it.each(['manual', 'schedule'] as const)('reads %s Run computer evidence and a persisted execution chat through HTTP and MCP', async (trigger) => {
    const test = await setup()
    const f = test.f
    try {
      const { workspaceId, workflowId } = f.f.scope
      const runId = trigger === 'schedule' ? await dispatchScheduledRun(f) : f.f.run.id
      const summaries = await f.services.runs.history.list(f.writer.principal, { workspaceId, workflowId })
      expect(summaries.items.find(item => item.runId === runId)?.trigger).toBe(trigger)
      await f.engine.start(runId)
      await terminal(f, runId)
      const source = (await executions(f, runId))[0]!
      expect(source.nativeSessionId).toBeTruthy()
      const traverse = vi.spyOn(f.runs, 'executionPages')
      const unchanged = await oldRunRows(f, [runId])
      const placementScope = { workspaceId, workflowId, runId, nodeId: source.workflowNodeId }
      const placementPath = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}`
        + `/runs/${runId}/nodes/${source.workflowNodeId}/placement`
      const headers = { authorization: `Bearer ${f.writer.token}` }
      const placement = await test.app.inject({ method: 'GET', url: placementPath, headers })
      expect(placement.statusCode, placement.body).toBe(200)
      expect(placement.json()).toEqual({ ...placementScope,
        readback: { evidence: 'legacy_missing', originalMainInstallationId: null } })
      expect(body(await test.mcp.callTool({ name: 'run_node_placement_get', arguments: placementScope })))
        .toEqual(placement.json())
      const target = { workspaceId, workflowId, runId, workflowNodeId: source.workflowNodeId }
      const initial = await read(test, target, source.id)
      expect(initial.kind).toBe('selected')
      const sent = SendAgentChatMessageResponseSchema.parse(body(await test.mcp.callTool({
        name: 'agent_chat_send', arguments: { workspaceId,
          selection: { workflowId, runId, workflowNodeId: source.workflowNodeId, executionId: source.id },
          message: { requestId: randomUUID(), expectedConversationId: null, content: 'Run follow-up.' } },
      })))
      const conversationId = sent.state.conversation!.id
      await eventually(() => (test.native.get(conversationId)?.prompts.length ?? 0) > 0)
      const native = test.native.get(conversationId)!
      expect(native.forks[0]?.source.nativeSessionId).toBe(source.nativeSessionId)
      native.completeReply('Run reply.')
      await eventually(async () => (await test.repository.turn(conversationId, sent.turn.requestId))?.delivery === 'completed')
      await withChatReadClock(async () => {
        const persisted = await read(test, target, source.id)
        expect(persisted.kind).toBe('selected')
        if (persisted.kind !== 'selected') throw new Error('Expected selected execution chat.')
        expect(persisted.key?.conversationId).toBe(conversationId)
        expect(persisted.state.messages.some(message => message.content === 'Run follow-up.')).toBe(true)
        expect(persisted.state.messages.some(message => message.content === 'Run reply.')).toBe(true)
        const denied = await f.access.issue({ name: 'Other workspace reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 60_000),
          grants: [{ actions: ['runs:read', 'workspace_locations:read', 'agent_chat:read'],
            scope: { workspaceIds: ['other-workspace'] } }],
        })
        const deniedMcp = await test.connect(denied.token)
        for (const [name, input] of [
          ['run_node_placement_get', placementScope],
          ['agent_chat_read', { workspaceId, selection: { workflowId, runId,
            workflowNodeId: source.workflowNodeId, executionId: source.id } }],
        ] as const) {
          const result = await deniedMcp.callTool({ name, arguments: input })
          expect(result.isError).toBe(true)
          expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
        }
        expect(await read(test, target, source.id)).toEqual(persisted)
      })
      expect(body(await test.mcp.callTool({ name: 'run_node_placement_get', arguments: placementScope })))
        .toEqual(placement.json())
      expect(await oldRunRows(f, [runId])).toEqual(unchanged)
      expect(traverse).not.toHaveBeenCalled()
    } finally { await test.close() }
  }, 90_000)

})
