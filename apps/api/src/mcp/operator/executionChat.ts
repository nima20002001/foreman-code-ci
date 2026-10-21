import { z } from 'zod'
import { ChatControlReceiptSchema, ChatDeliveryReceiptSchema, ChatQueueCancelRequestSchema,
  ChatSendRequestSchema, ChatStopRequestSchema, EngineChatReadbackSchema, EngineChatMessageSchema,
  WorkflowExecutionChatReadRequestSchema, WorkflowExecutionChatResolutionSchema,
  WorkflowExecutionChatSelectionSchema, WorkflowExecutionChatMessageRequestSchema } from '@foreman-code/contracts'
import { DomainError } from '../../modules/errors.js'
import { defineOperatorTool, type OperatorToolDefinition } from './definition.js'

const Resolve = z.object({ resolve: WorkflowExecutionChatSelectionSchema }).strict()
function workflowTarget(input: { target: { kind: string } }): boolean {
  return input.target.kind === 'workflow_execution' || input.target.kind === 'workflow_coordinator'
}
const Send = ChatSendRequestSchema.refine(workflowTarget, { message: 'Use an exact workflow execution or coordinator target.' })
const Stop = ChatStopRequestSchema.refine(workflowTarget, { message: 'Use an exact workflow execution or coordinator target.' })
const Cancel = ChatQueueCancelRequestSchema.refine(workflowTarget, { message: 'Use an exact workflow execution or coordinator target.' })
const CancelAll = Cancel.refine(input => input.selection.kind === 'all', { message: 'Use selection:{kind:"all"}.' })
const engineSchemas = {
  agent_chat_read: { input: z.union([WorkflowExecutionChatMessageRequestSchema, WorkflowExecutionChatReadRequestSchema, Resolve]),
    output: z.union([EngineChatReadbackSchema, WorkflowExecutionChatResolutionSchema, EngineChatMessageSchema]) },
  agent_chat_send: { input: Send, output: ChatDeliveryReceiptSchema },
  agent_chat_interrupt: { input: Stop, output: ChatControlReceiptSchema },
  agent_chat_cancel_queued: { input: Cancel, output: ChatControlReceiptSchema },
  agent_chat_cancel_all_queued: { input: CancelAll, output: ChatControlReceiptSchema },
} as const
type EngineToolName = keyof typeof engineSchemas
function isEngineTool(name: string): name is EngineToolName { return name in engineSchemas }

function objectShapes(schema: z.ZodType): Array<Record<string, z.ZodType>> {
  const definition = schema._zod.def as { type: string; shape?: Record<string, z.ZodType>; options?: z.ZodType[] }
  if (definition.type === 'object') return [definition.shape!]
  if (definition.type === 'union') return definition.options!.flatMap(objectShapes)
  return []
}

/** MCP discovery requires one object envelope with top-level properties. Every accepted
 * value still validates against its exact original arm; the existing definition's field wins. */
function objectEnvelope(existing: z.ZodType, engine: z.ZodType): z.ZodType {
  const fields = new Map<string, z.ZodType[]>()
  for (const shape of [...objectShapes(existing), ...objectShapes(engine)]) {
    for (const [name, field] of Object.entries(shape)) {
      const known = fields.get(name) ?? []
      if (!known.includes(field)) fields.set(name, [...known, field])
    }
  }
  const alternatives = z.union([existing, engine])
  return z.object(Object.fromEntries([...fields].map(([name, options]) =>
    [name, (options.length === 1 ? options[0]! : z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]])).optional()])))
    .strict().superRefine((value, context) => {
      const parsed = alternatives.safeParse(value)
      if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
    })
}

/** Integration belongs to the shared registry. C's legacy conversation definitions
 * and their omitted-intent/scope semantics stay owned by the conversation service. */
export function withWorkflowExecutionChatTools(legacy: readonly OperatorToolDefinition[]): OperatorToolDefinition[] {
  const definitions = legacy.map(tool => {
    if (!isEngineTool(tool.name)) return tool
    const name = tool.name, schema = engineSchemas[name]
    return defineOperatorTool({ ...tool, handle: undefined,
      enabled: services => !!services.executionChat || (tool.enabled?.(services) ?? true),
      // These four existing definitions use Zod, just as the shared wire schemas do.
      inputSchema: objectEnvelope(tool.inputSchema as z.ZodType, schema.input),
      outputSchema: tool.outputSchema ? objectEnvelope(tool.outputSchema as z.ZodType, schema.output) : schema.output,
      description: `${tool.description}\nFor Run-owned work, pass the shared exact target directly at the top level. `
        + 'agent_chat_read also accepts resolve:{workspaceId,workflowId,workflowNodeId,runId?,workflowVersionId?,executionId?,waitingActivationId?}; '
        + 'pass {target,messageId} to read the complete native message when a page reports truncation. '
        + 'choose ambiguous Run/execution identities explicitly. The response preserves the original native history and target, '
        + 'without creating a conversation or Run. Exact-target sends require explicit intent; auto never interrupts. '
        + 'Stop scope active_turn preserves queued input and active_and_queued cancels it. Cancel selection one/all affects only queued input. '
        + 'Reuse commandId with identical content and target after a lost response. Waiting coordinator replies use consultation receipts, '
        + 'while workflow executions expose explicit same-work continuation lineage.',
      run: async (context, input, call) => {
        const value = input as Record<string, unknown>
        const target = value.target as { kind?: unknown } | undefined
        if (!('resolve' in value) && target?.kind !== 'workflow_execution' && target?.kind !== 'workflow_coordinator') {
          if (!context.services.agentChat || !tool.run) throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'Standalone Agent chat is unavailable.', 503)
          return tool.run(context, input, call)
        }
        const service = context.services.executionChat
        if (!service) throw new DomainError('COLLABORATION_UNAVAILABLE', 'Run-owned chat is unavailable.', 503)
        if (name === 'agent_chat_read') {
          if ('resolve' in value) return service.resolve(context.principal, Resolve.parse(input).resolve)
          if ('messageId' in value) {
            const request = WorkflowExecutionChatMessageRequestSchema.parse(input)
            return service.message(context.principal, request.target, request.messageId)
          }
          return service.read(context.principal, WorkflowExecutionChatReadRequestSchema.parse(input))
        }
        if (name === 'agent_chat_send') return service.deliver(context.principal, ChatSendRequestSchema.parse(input))
        if (name === 'agent_chat_interrupt') return service.stop(context.principal, ChatStopRequestSchema.parse(input))
        return service.cancel(context.principal, ChatQueueCancelRequestSchema.parse(input))
      },
    })
  })
  if (!definitions.some(tool => tool.name === 'agent_chat_cancel_all_queued')) definitions.push(defineOperatorTool({
    name: 'agent_chat_cancel_all_queued',
    requires: [['agent_chat:cancel','resource'],['agent_chat:read','resource']],
    enabled: services => !!services.executionChat,
    description: 'Cancel every still-queued delivery for the supplied exact workflow execution or coordinator target. '
      + 'Pass selection:{kind:"all"}; this never interrupts an active turn, creates work, or redirects input. '
      + 'Reuse commandId with identical target and input after a lost response. Requires scoped agent_chat:cancel and agent_chat:read.',
    inputSchema: CancelAll, outputSchema: ChatControlReceiptSchema,
    annotations: { readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false },
    run: (context,input) => context.services.executionChat!.cancel(context.principal,input),
  }))
  return definitions
}
