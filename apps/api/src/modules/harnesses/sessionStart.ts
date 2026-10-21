import type { NativeSessionStart, WorkflowNativeSessionStart } from './port.js'

export function isWorkflowStart(start: NativeSessionStart): start is WorkflowNativeSessionStart {
  return start.kind === undefined || start.kind === 'workflow'
}

export function sessionStartConfiguration(start: NativeSessionStart) {
  return isWorkflowStart(start) ? start.request.configuration : start.configuration
}

export function sessionStartSystemPrompt(start: NativeSessionStart) {
  if (start.kind === 'operator') return undefined
  return isWorkflowStart(start) ? start.request.systemPrompt : start.systemPrompt
}

export function sessionStartDirectory(start: NativeSessionStart) {
  return isWorkflowStart(start) ? start.request.workingDirectory : start.workingDirectory
}

export function sessionStartOwner(start: NativeSessionStart) {
  if (start.kind === 'operator') return start.configuration.operatorId
  return isWorkflowStart(start) ? start.request.configuration.agentId : start.configuration.agentId
}

export function sessionStartCorrelation(start: NativeSessionStart) {
  return start.correlationId ?? (isWorkflowStart(start) ? start.request.executionId : undefined)
}
