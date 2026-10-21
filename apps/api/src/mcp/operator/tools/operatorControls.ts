import { z } from 'zod'
import { CancelOperatorTurnRequestSchema, CancelOperatorTurnResponseSchema, RespondOperatorInteractionRequestSchema } from '@foreman-code/contracts'
import { defineOperatorTool } from '../definition.js'


/** Actual HTTP control services and native receipt fence, including current owner/grant rechecks. */
export const operatorControlTools = [
  defineOperatorTool({
    name: 'operator_chat_cancel',
    requires: [['operator_chat:cancel', 'global'], ['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Cancel the exact active model request in your Operator conversation. Pass requestId from readback and reuse commandId with identical input after a lost response. Without commandId the service uses one deterministic receipt for this model request. A cancellation request is not native terminal evidence. Requires operator_chat:cancel and operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: CancelOperatorTurnRequestSchema }).strict(),
    outputSchema: CancelOperatorTurnResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context, { conversationId, request }) => ({
    state: await context.services.operatorChat!.cancel(conversationId, request.requestId, context.principal, request.commandId, 'mcp'),
  }),
  }),
  defineOperatorTool({
    name: 'operator_chat_respond',
    requires: [['operator_chat:respond', 'global'], ['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Answer the pending native request in your Operator conversation using offered nativeRequestId and '
      + 'optionId plus active model requestId from operator_chat_get. For a standalone session request with no active '
      + 'model request, use nativeRequestId as requestId. For questions and forms, supply response matching '
      + 'the option input schema. Check responseAvailability.available and its message first. Reuse commandId and '
      + 'identical input after response loss. An uncertain response is never resent. '
      + 'Read operator_chat_get activitySnapshot for the saved decision and providerAcknowledged: '
      + 'a recorded answer alone is not delivery confirmation; native consumption may confirm it later. '
      + 'Requires operator_chat:respond and operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: RespondOperatorInteractionRequestSchema }).strict(),
    outputSchema: CancelOperatorTurnResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, { conversationId, request }) => ({
    state: await context.services.operatorChat!.respond(conversationId, request, context.principal, 'mcp'),
  }),
  }),
]
