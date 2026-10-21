import { isDeepStrictEqual } from 'node:util'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { NativeSessionStart } from './port.js'
import { hasWorkflowRequest } from './sessionStart.js'
import { HarnessExecutionError } from './errors.js'

export function assertConsultationSession(start: NativeSessionStart, session: NativeSessionReference): void {
  if (start.kind !== 'workflow-consultation') return
  if (start.consultation.nativeSessionId !== session.nativeSessionId
    || start.consultation.runId !== start.request.runId
    || start.correlationId !== `consultation:${start.consultation.consultationId}`
    || start.request.configuration.harness.harness !== session.harness
    || !['master', 'orchestrator'].includes(start.request.configuration.productRole ?? '')) {
    throw new HarnessExecutionError('CONSULTATION_NATIVE_BINDING_CONFLICT',
      'The consultation must retain its exact coordinator session and accepted configuration.')
  }
}

export function assertConsultationRebind(previous: NativeSessionStart, next: NativeSessionStart,
  session: NativeSessionReference): void {
  if (previous.kind === 'agent-chat' && next.kind === 'agent-chat') {
    if (previous.conversationId !== next.conversationId || previous.workflowId !== next.workflowId
      || previous.workflowNodeId !== next.workflowNodeId || previous.workingDirectory !== next.workingDirectory
      || !isDeepStrictEqual(previous.configuration, next.configuration)
      || !next.environment || next.environment.agentId !== next.configuration.agentId
      || next.configuration.harness.harness !== session.harness) {
      throw new HarnessExecutionError('CHAT_NATIVE_BINDING_CONFLICT',
        'Application access can change only on the same idle Agent conversation.')
    }
    return
  }
  assertConsultationSession(next, session)
  assertConsultationSession(previous, session)
  if (!hasWorkflowRequest(previous) || !hasWorkflowRequest(next)
    || previous.kind !== 'workflow-consultation' && next.kind !== 'workflow-consultation'
    || previous.request.executionId !== next.request.executionId
    || previous.request.runId !== next.request.runId
    || previous.request.workspaceId !== next.request.workspaceId
    || previous.request.workflowNodeId !== next.request.workflowNodeId
    || previous.request.workingDirectory !== next.request.workingDirectory
    || previous.request.runtimeDirectory !== next.request.runtimeDirectory
    || !isDeepStrictEqual(previous.request.configuration, next.request.configuration)
    || !isDeepStrictEqual(previous.request.input, next.request.input)
    || !next.environment || next.environment.agentId !== next.request.configuration.agentId) {
    throw new HarnessExecutionError('CONSULTATION_NATIVE_BINDING_CONFLICT',
      'Application access can change only on the exact idle coordinator source session.')
  }
}
