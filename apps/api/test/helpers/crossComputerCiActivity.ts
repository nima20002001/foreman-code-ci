import type { RunActivityPublic } from '@foreman-code/contracts/wave25'

export function requireCiWorkflowActivity(items: readonly RunActivityPublic[], expected: {
  runId: string
  agentExecutionIds: string[]
  ciTicketIds: string[]
}) {
  if (items.some(item => item.scope.runId !== expected.runId)) throw new Error('Activity belongs to another Run.')
  for (const executionId of expected.agentExecutionIds) {
    const states = items.filter(item => item.kind === 'agent_work' && item.refs.executionId === executionId)
      .map(item => item.status)
    if (!states.includes('completed')) {
      throw new Error(`Agent ${executionId} is missing its completed Run activity.`)
    }
  }
  for (const ticketId of expected.ciTicketIds) {
    const states = items.filter(item => item.kind === 'job_work' && item.refs.ciTicketId === ticketId)
      .sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1)
      .map(item => item.status)
    if (!states.includes('queued') || !states.includes('completed')) {
      throw new Error(`CI ${ticketId} is missing its queued or completed Run activity.`)
    }
    if (states.indexOf('queued') >= states.indexOf('completed')) {
      throw new Error(`CI ${ticketId} activity is out of order: queued must precede completed.`)
    }
  }
}
