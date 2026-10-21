import { describe, expect, it } from 'vitest'
import { JobInitiatingAgentSchema } from './jobs.js'
import { JobQueuedStartSchema, JobQueueListInputSchema } from './jobAdmission.js'

const origin = { workflowId: 'workflow', runId: 'run', agentId: 'agent', executionId: 'execution' }
describe('Agent CI origin', () => {
  it('requires the initiating Run, Agent and execution together', () => {
    expect(JobInitiatingAgentSchema.parse(origin)).toEqual(origin)
    expect(JobInitiatingAgentSchema.safeParse({ ...origin, executionId: undefined }).success).toBe(false)
  })
  it('supports execution-scoped queue reads without accepting caller-supplied origin on Start', () => {
    expect(JobQueueListInputSchema.parse({ initiatingExecutionId: origin.executionId }))
      .toMatchObject({ initiatingExecutionId: origin.executionId })
    expect(JobQueuedStartSchema.safeParse({ commandId: 'command', definitionId: 'definition',
      expectedRevision: 1, initiatingAgent: origin }).success).toBe(false)
  })
})
