import { HarnessExecutionRequestSchema, type ChatSendRequest, type HarnessExecutionRequest } from '@foreman-code/contracts'
import type { WorkflowQueuedInput } from '../collaboration/workflowControlTypes.js'
import { DomainError } from '../errors.js'

export function admittedWorkflowChatPrompt(command: { nativePrompt?: string }): string {
  if (!command.nativePrompt) throw new DomainError('CHAT_NATIVE_PROMPT_UNAVAILABLE',
    'The admitted native prompt is unavailable. The original input remains retained.', 409)
  return command.nativePrompt
}

/** Only admitted text and immutable file references enter the native prompt.
 * Attachments-only sends still carry a real, nonempty input. */
export function workflowChatInputPrompt(request: Pick<ChatSendRequest, 'content' | 'attachments'>): string {
  const attachments = request.attachments.length ? [
    'Attached files (read these exact revisions with the available file tools):',
    ...request.attachments.map(file => JSON.stringify({ fileId: file.fileId, revisionId: file.revisionId })),
  ].join('\n') : undefined
  return [request.content.trim() ? request.content : undefined, attachments].filter(Boolean).join('\n\n')
}

/** The durable input stays unchanged. Reconstruct this same request on recovery
 * from the already-claimed receipt; a later queued message cannot replace it. */
export function appendWorkflowChatInput(request: HarnessExecutionRequest,
  input: WorkflowQueuedInput | undefined): HarnessExecutionRequest {
  if (!input) return request
  return HarnessExecutionRequestSchema.parse({ ...request,
    initialPrompt: workflowChatDirectionPrompt(request, input) })
}

export function workflowChatDirectionPrompt(request: Pick<HarnessExecutionRequest, 'initialPrompt'>,
  input: Pick<WorkflowQueuedInput, 'receiptId' | 'request'>): string {
  return [request.initialPrompt,
    `User direction for this existing work (delivery ${JSON.stringify(input.receiptId)}):`,
    workflowChatInputPrompt(input.request)].filter(Boolean).join('\n\n')
}
