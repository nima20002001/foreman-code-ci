import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { body, setup, terminal } from './sch06-agent-chat.helpers.js'

describe.skipIf(!postgresEnabled)('Operator query Run chat PostgreSQL / HTTP / MCP', () => {
  it('preserves the legacy Operator read shape for callers that still use query', async () => {
    const test = await setup(), f = test.f
    try {
      await f.engine.start(f.f.run.id); await terminal(f, f.f.run.id)
      const node = f.f.version.definition.nodes[0]!
      const query = { workflowId: f.f.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId, runId: f.f.run.id }
      const result = body(await test.mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.f.scope.workspaceId, query } }))
      expect(AgentChatStateSchema.parse(result).context).toEqual({ workspaceId: f.f.scope.workspaceId, ...query })
      expect(result).not.toHaveProperty('kind')
      expect(test.native.size).toBe(0)
    } finally { await test.close() }
  }, 60000)
})
