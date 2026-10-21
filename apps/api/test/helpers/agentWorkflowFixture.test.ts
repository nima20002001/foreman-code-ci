import { describe, expect, it } from 'vitest'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { agentWorkflowNode, agentWorkflowVersion } from './agentWorkflowFixture.js'

describe('Agent-only workflow fixtures', () => {
  it('preserves saved Agent version facts exactly', () => {
    const { version } = makeCurrentWorkflowFixture('agent-version')
    expect(agentWorkflowVersion(version)).toEqual(version)
  })
  it('rejects an actual Job node instead of fabricating an Agent or dropping it', () => {
    const { version } = makeCurrentWorkflowFixture('job-version')
    const job = JobWorkflowNodeSchema.parse({ kind: 'job', id: 'job-node', name: 'Build', jobDefinitionId: 'job-definition',
      jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version' })
    expect(() => agentWorkflowNode(job)).toThrow('Agent workflow node')
    expect(() => agentWorkflowVersion({ ...version, definition: { ...version.definition, nodes: [...version.definition.nodes, job] } })).toThrow('Agent workflow node')
  })
})
