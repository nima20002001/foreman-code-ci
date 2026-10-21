import { OperatorToolSchemaInputSchema, OperatorToolSchemaResultSchema } from '@foreman-code/contracts/operator-mcp'
import { DomainError } from '../../../modules/errors.js'
import { defineOperatorTool } from '../definition.js'
import { operatorCapabilities } from './context.js'

export const toolSchemaTools = [defineOperatorTool({
  name: 'operator_tool_schema_get',
  requires: [['capabilities:read', 'caller']],
  description: 'Read one available Operator tool’s complete input schema, instructions and permission requirements. '
    + 'Requires capabilities:read and the target tool’s original discovery grants. '
    + 'Set includeOutputSchema:true for its output schema. This read never invokes the target operation.',
  inputSchema: OperatorToolSchemaInputSchema,
  outputSchema: OperatorToolSchemaResultSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (context, input, { extra, catalog, tools: registry }) => {
    const tools = await catalog?.(extra) ?? []
    const tool = tools.find((candidate) => candidate.name === input.name)
    if (!tool) throw new DomainError('ACCESS_DENIED', 'The requested tool is unavailable to this caller.', 403)
    const requirement = operatorCapabilities(context, {}, registry, tools.map(candidate => candidate.name)).requirements.find((entry) => entry.name === input.name)
    return {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      ...(input.includeOutputSchema && tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      permissionRequirements: {
        ...(requirement ? { actions: requirement.actions } : {}),
        detail: [tool.description, requirement?.detail].filter(Boolean).join(' '),
      },
    }
  },
})]
