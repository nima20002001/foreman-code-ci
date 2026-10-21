import type { DeliveryTarget } from '@foreman-code/contracts'

export function deliveryTargetLabel(target: DeliveryTarget): string {
  if (target.kind === 'operator_conversation') return 'Operator conversation'
  if (target.kind === 'agent_conversation') return `Agent conversation ${target.conversationId}`
  if (target.kind === 'workflow_coordinator') return `Run ${target.runId} · Waiting for child reports`
  return `Run ${target.execution.runId} · Attempt ${target.execution.attempt} · ${target.execution.executionId}`
}

