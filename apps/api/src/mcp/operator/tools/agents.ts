
import { AgentGetInputSchema, ManagedAgentDetailSchema, ManagedAgentPageSchema } from '@foreman-code/contracts/management'
import { OperatorAgentListInputSchema } from '@foreman-code/contracts/operator-mcp'
import { defineOperatorTool } from '../definition.js'

export const agentTools = [
  defineOperatorTool({
    name: 'agent_list',
    requires: [['agents:read', 'resource']],
    description: 'List authorized logical agents and metadata revisions (10 by default).', inputSchema: OperatorAgentListInputSchema,
    outputSchema: ManagedAgentPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.agents.list(context.principal, input),
  }),
  defineOperatorTool({
    name: 'agent_get',
    requires: [['agents:read', 'workspace']],
    description: 'Read a logical agent, its saved nativeTools loading policy and the workflows that reference it. Omitted policy fields inherit host settings; Foreman Code remains role-scoped.', inputSchema: AgentGetInputSchema,
    outputSchema: ManagedAgentDetailSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.agents.get(context.principal, input.workspaceId, input.agentId),
  }),
]
