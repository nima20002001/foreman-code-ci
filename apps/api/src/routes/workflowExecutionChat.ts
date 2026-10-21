import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ChatQueueCancelRequestSchema, ChatSendRequestSchema, ChatStopRequestSchema,
  WORKFLOW_EXECUTION_CHAT_ROUTE, WorkflowExecutionChatReadRequestSchema,
  WorkflowExecutionChatSelectionSchema, WorkflowExecutionChatMessageRequestSchema } from '@foreman-code/contracts'
import { requirePrincipal } from '../modules/access/http.js'
import type { WorkflowExecutionChatService } from '../modules/collaboration/workflowChatService.js'
import { asWorkflowChatTarget } from '../modules/collaboration/workflowControlRecords.js'
import { DomainError } from '../modules/errors.js'
import { registerWorkflowExecutionChatEvents } from './workflowExecutionChatEvents.js'

type Scope = { workspaceId: string; workflowId: string }
const SelectionQuery = z.object({ workflowNodeId: z.string().min(1), runId: z.string().min(1).optional(),
  workflowVersionId: z.string().min(1).optional(), executionId: z.string().min(1).optional(),
  waitingActivationId: z.string().min(1).optional(), cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50) }).strict()
function targetScope(params: Scope, raw: unknown) {
  const target = asWorkflowChatTarget(raw)
  if (target.agent.workspaceId !== params.workspaceId || target.agent.workflowId !== params.workflowId) {
    throw new DomainError('RESOURCE_ID_MISMATCH', 'The exact chat target must match its workflow URL.', 400)
  }
}
export function registerWorkflowExecutionChatRoutes(app: FastifyInstance, service: WorkflowExecutionChatService): void {
  registerWorkflowExecutionChatEvents(app, service)
  app.get<{ Params: Scope; Querystring: unknown }>(`${WORKFLOW_EXECUTION_CHAT_ROUTE}/target`, request =>
    service.resolve(requirePrincipal(request), WorkflowExecutionChatSelectionSchema.parse({ ...request.params, ...SelectionQuery.parse(request.query) })))
  app.post<{ Params: Scope; Body: unknown }>(`${WORKFLOW_EXECUTION_CHAT_ROUTE}/read`, request => {
    const input = WorkflowExecutionChatReadRequestSchema.parse(request.body)
    targetScope(request.params, input.target)
    return service.read(requirePrincipal(request), input)
  })
  app.post<{ Params: Scope; Body: unknown }>(`${WORKFLOW_EXECUTION_CHAT_ROUTE}/message`, request => {
    const input = WorkflowExecutionChatMessageRequestSchema.parse(request.body)
    targetScope(request.params, input.target)
    return service.message(requirePrincipal(request), input.target, input.messageId)
  })
  app.post<{ Params: Scope; Body: unknown }>(`${WORKFLOW_EXECUTION_CHAT_ROUTE}/send`, request => {
    const input = ChatSendRequestSchema.parse(request.body)
    targetScope(request.params, input.target)
    return service.deliver(requirePrincipal(request), input)
  })
  app.post<{ Params: Scope; Body: unknown }>(`${WORKFLOW_EXECUTION_CHAT_ROUTE}/stop`, request => {
    const input = ChatStopRequestSchema.parse(request.body)
    targetScope(request.params, input.target)
    return service.stop(requirePrincipal(request), input)
  })
  app.post<{ Params: Scope; Body: unknown }>(`${WORKFLOW_EXECUTION_CHAT_ROUTE}/queue/cancel`, request => {
    const input = ChatQueueCancelRequestSchema.parse(request.body)
    targetScope(request.params, input.target)
    return service.cancel(requirePrincipal(request), input)
  })
}
