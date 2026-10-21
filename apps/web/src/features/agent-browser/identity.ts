import type { AgentSubject, BrowserSession, BrowserTabLease } from './types'

export function sameSubject(left: AgentSubject, right: AgentSubject): boolean {
  const a = left.agent, b = right.agent
  if (left.kind !== right.kind || a.workspaceId !== b.workspaceId || a.workflowId !== b.workflowId
    || a.workflowNodeId !== b.workflowNodeId || a.agentId !== b.agentId
    || a.configurationVersionId !== b.configurationVersionId || a.productRole !== b.productRole) return false
  if (left.kind === 'execution' && right.kind === 'execution') {
    return left.execution.runId === right.execution.runId
      && left.execution.workflowVersionId === right.execution.workflowVersionId
      && left.execution.executionId === right.execution.executionId
      && left.execution.activationId === right.execution.activationId
      && left.execution.attempt === right.execution.attempt
  }
  if (left.kind === 'conversation' && right.kind === 'conversation') return left.conversationId === right.conversationId
  if (left.kind === 'coordinator_consultation' && right.kind === 'coordinator_consultation') {
    const x = left.binding, y = right.binding
    return x.runId === y.runId && x.workflowVersionId === y.workflowVersionId
      && x.waitingActivationId === y.waitingActivationId && x.delegationGroupId === y.delegationGroupId
      && x.consultationId === y.consultationId && x.nativeSessionId === y.nativeSessionId && x.purpose === y.purpose
  }
  return false
}

export function subjectKey(subject: AgentSubject): readonly string[] {
  const agent = subject.agent
  const common = [agent.workspaceId, agent.workflowId, agent.workflowNodeId, agent.agentId, agent.configurationVersionId, agent.productRole]
  if (subject.kind === 'execution') return [...common, subject.kind, subject.execution.runId,
    subject.execution.workflowVersionId, subject.execution.executionId, subject.execution.activationId ?? '', String(subject.execution.attempt)]
  if (subject.kind === 'conversation') return [...common, subject.kind, subject.conversationId]
  const binding = subject.binding
  return [...common, subject.kind, binding.runId, binding.workflowVersionId, binding.waitingActivationId,
    binding.delegationGroupId, binding.consultationId, binding.nativeSessionId]
}

export function ownsTab(session: BrowserSession, tab: BrowserTabLease): boolean {
  return tab.sessionId === session.id && tab.browserGeneration === session.browserGeneration
}

export function subjectLabel(subject: AgentSubject): string {
  if (subject.kind === 'execution') return `Run ${subject.execution.runId.slice(0, 8)} · Attempt ${subject.execution.attempt}`
  if (subject.kind === 'conversation') return `Conversation ${subject.conversationId.slice(0, 8)}`
  return `Run ${subject.binding.runId.slice(0, 8)} · Consultation ${subject.binding.consultationId.slice(0, 8)}`
}

export function roleLabel(subject: AgentSubject): string {
  return subject.agent.productRole === 'coder' ? 'Worker' : subject.agent.productRole === 'master' ? 'Master' : 'Orchestrator'
}
