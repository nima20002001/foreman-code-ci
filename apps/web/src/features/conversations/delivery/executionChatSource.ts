import { z } from 'zod'
import { DeliveryTargetSchema, EngineChatMessageSchema, type DeliveryTarget, type EngineChatMessage } from '@foreman-code/contracts'

export type ExecutionChatTarget = Extract<DeliveryTarget, { kind: 'workflow_execution' | 'workflow_coordinator' }>
export const executionChatNoticeSchema = z.object({ target: DeliveryTargetSchema, revision: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative().optional(),
  message: EngineChatMessageSchema.optional(), snapshotRequired: z.boolean().optional() })
export type ExecutionChatNotice = z.infer<typeof executionChatNoticeSchema>

/** D connects its existing native observation/readback owner; this creates no new engine manager. */
export interface ExecutionChatSource {
  subscribe(target: ExecutionChatTarget, receive: (notice: ExecutionChatNotice) => void,
    options: { signal: AbortSignal; reconnect(): void; error(error: Error): void }): () => void
  readMessage(target: ExecutionChatTarget, message: EngineChatMessage, options: { signal: AbortSignal }): Promise<EngineChatMessage>
}

export function messageBelongsToExecution(message: EngineChatMessage, target: ExecutionChatTarget) {
  const provenance = message.provenance
  if (target.kind === 'workflow_execution') return provenance.kind === 'execution'
    && provenance.execution.runId === target.execution.runId && provenance.execution.workflowVersionId === target.execution.workflowVersionId
    && provenance.execution.executionId === target.execution.executionId && provenance.execution.attempt === target.execution.attempt
    && provenance.execution.activationId === target.execution.activationId
  return provenance.kind === 'consultation' && provenance.binding.runId === target.runId
    && provenance.binding.waitingActivationId === target.waitingActivationId
    && (!message.activityNative || message.activityNative.sessionId === provenance.binding.nativeSessionId)
}
