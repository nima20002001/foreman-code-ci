import { z } from 'zod'
import { WorkflowChatPostRequestSchema, WorkflowChatPostResponseSchema, ChatDeliveryReceiptSchema } from '@foreman-code/contracts'
import { defineOperatorTool } from '../definition.js'
import type { OperatorRequestContext } from '../types.js'
import type { WorkflowChatService } from '../../../modules/workflow-chat/service.js'

const scope = { workspaceId: z.string().min(1), workflowId: z.string().min(1) }
const page = z.object({ ...scope, cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
  runId: z.string().min(1).optional(), postId: z.string().min(1).optional(), receiptId: z.string().min(1).optional(),
  commandId: z.string().min(1).optional(), bodyCursor: z.string().optional(), mode: z.literal('body').optional() })
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

export function workflowChatTools(chat?: WorkflowChatService) {
  const service = (context: OperatorRequestContext) => chat ?? context.services.workflowChat!
  const enabled = (services: OperatorRequestContext['services']) => !!chat || !!services.workflowChat
  return [
    defineOperatorTool({ name: 'workflow_chat_read', requires: [['agent_chat:read', 'workflow']], enabled,
      description: 'Read the workflow Group channel. Plain posts do not wake agents. Pages default to 50 and cap at 100/256 KiB. Exact postId or receiptId remains reachable outside a run filter. Use mode body and postId, then bodyCursor for complete retained text. commandId reconciles a lost post response without dispatch.',
      inputSchema: page, annotations: readAnnotations,
      run: (context, input) => input.postId && (input.mode === 'body' || input.bodyCursor !== undefined)
        ? service(context).body(context.principal, input, input.postId, input.bodyCursor) : service(context).read(context.principal, input, input),
    }),
    defineOperatorTool({ name: 'workflow_chat_post', requires: [['agent_chat:write', 'workflow'], ['agent_chat:read', 'workflow']], enabled,
      description: 'Atomically post exact text and explicitly resolved UTF-16 mention chips with one delivery per distinct node. Raw @ text and Agent posts never wake agents. Retain commandId after response loss; replay only reads the same post and receipts. Intent is explicit; interrupt_and_send is never implied. Agent replies use replyToPostId with empty mentions and deliveries.',
      inputSchema: WorkflowChatPostRequestSchema, outputSchema: WorkflowChatPostResponseSchema,
      annotations: { ...readAnnotations, readOnlyHint: false }, run: (context, input) => service(context).post(context.principal, input),
    }),
    defineOperatorTool({ name: 'workflow_chat_deliveries_read', requires: [['agent_chat:read', 'workflow']], enabled,
      description: 'Read independent persisted Group delivery receipts, requested/applied intent and exact target. Filter postId, receiptId or commandId to reconcile without resending successful siblings. A receipt is delivery evidence, never workflow completion evidence.',
      inputSchema: page, annotations: readAnnotations, run: (context, input) => service(context).receipts(context.principal, input, input),
    }),
    defineOperatorTool({ name: 'workflow_chat_delivery_cancel', requires: [['agent_chat:cancel', 'workflow'], ['agent_chat:read', 'workflow']], enabled,
      description: 'Cancel one still-queued Group delivery. It never stops an active turn. Submitted work requires an exact Agent stop or steer. Preserve commandId for replay.',
      inputSchema: z.object({ ...scope, receiptId: z.string().min(1), commandId: z.string().min(1).optional() }), outputSchema: ChatDeliveryReceiptSchema,
      annotations: { ...readAnnotations, readOnlyHint: false },
      run: (context, input) => service(context).cancel(context.principal, input, input.receiptId, input.commandId),
    }),
  ]
}
