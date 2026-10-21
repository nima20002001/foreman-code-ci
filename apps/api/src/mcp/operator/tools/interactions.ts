import { RespondToInteractionRequestSchema, RespondToInteractionResponseSchema } from '@foreman-code/contracts'
import {
  InteractionGetInputSchema,
  InteractionSummaryInputSchema, InteractionSummaryResultSchema,
  InteractionListInputSchema,
  ManagedInteractionPageSchema,
  ManagedInteractionSchema,
} from '@foreman-code/contracts/management'
import { defineOperatorTool } from '../definition.js'


export const interactionTools = [
  defineOperatorTool({
    name: 'interaction_summary',
    requires: [['interactions:read', 'resource']],
    enabled: s => !!s.interactions,
    description: 'Read pending approval and workflow direction counts over authorized scopes and the optional handler filter; no decision authority is granted.',
    inputSchema: InteractionSummaryInputSchema, outputSchema: InteractionSummaryResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.interactions!.summary(context.principal, input),
  }),
  defineOperatorTool({
    name: 'interaction_list',
    requires: [['interactions:read', 'resource']],
    enabled: s => !!s.interactions,
    description: 'List authorized native approvals and owner-handled workflow direction waits with scoped pending counts. Direction waits offer finish with findings, continue in a new Run, or stop.',
    inputSchema: InteractionListInputSchema, outputSchema: ManagedInteractionPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.interactions!.list(context.principal, input),
  }),
  defineOperatorTool({
    name: 'interaction_get',
    requires: [['interactions:read', 'resource']],
    enabled: s => !!s.interactions,
    description: 'Read one authorized approval or workflow direction interaction, its offered choices and response availability, including canceled history.',
    inputSchema: InteractionGetInputSchema, outputSchema: ManagedInteractionSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.interactions!.get(context.principal, input.interactionId),
  }),
  defineOperatorTool({
    name: 'interaction_respond',
    requires: [['interactions:respond', 'resource'], ['interactions:read', 'resource']],
    enabled: s => !!s.interactions,
    description: 'Respond to a user-handled approval or workflow direction interaction using its offered option and revision. '
      + 'For questions or forms, supply response matching the option input schema. Requires scoped read and respond grants. '
      + 'Direction finish accepts the recorded findings; continue requires direction and runs:start, workflows:read and workspace_locations:read grants; stop requires runs:stop. '
      + 'Designated Orchestrator interactions remain assigned to their bound reviewer.',
    inputSchema: RespondToInteractionRequestSchema, outputSchema: RespondToInteractionResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.interactions!.respond(context.principal, input, 'mcp'),
  }),
]
