import type { NativeSessionStart, WorkflowNativeSessionStart, WorkflowConsultationNativeSessionStart } from './port.js'

export function isWorkflowStart(start: NativeSessionStart): start is WorkflowNativeSessionStart {
  return start.kind === undefined || start.kind === 'workflow'
}

export function hasWorkflowRequest(start: NativeSessionStart): start is WorkflowNativeSessionStart | WorkflowConsultationNativeSessionStart {
  return isWorkflowStart(start) || start.kind === 'workflow-consultation'
}

export function sessionStartConfiguration(start: NativeSessionStart) {
  return hasWorkflowRequest(start) ? start.request.configuration : start.configuration
}

export function sessionStartSystemPrompt(start: NativeSessionStart) {
  if (start.kind === 'operator') return undefined
  return hasWorkflowRequest(start) ? start.request.systemPrompt : start.systemPrompt
}

export function sessionStartDirectory(start: NativeSessionStart) {
  return hasWorkflowRequest(start) ? start.request.workingDirectory : start.workingDirectory
}

export function sessionStartOwner(start: NativeSessionStart) {
  if (start.kind === 'operator') return start.configuration.operatorId
  return hasWorkflowRequest(start) ? start.request.configuration.agentId : start.configuration.agentId
}

export function sessionStartCorrelation(start: NativeSessionStart) {
  return start.correlationId ?? (isWorkflowStart(start) ? start.request.executionId : undefined)
}
