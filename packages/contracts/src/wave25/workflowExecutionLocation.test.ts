import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import type { WorkflowDefinitionV3 } from './workflowShape.js'
import { workflowRequiresWorkspaceDirectory, workflowUsesAgentPlacements } from './workflowExecutionLocation.js'

it('uses accepted Agent roots for artifact workflows and still requires the workspace directory for Jobs', () => {
  const { version } = makeCurrentWorkflowFixture()
  const graph: WorkflowDefinitionV3 = structuredClone(version.definition)
  expect(workflowUsesAgentPlacements(graph)).toBe(false)
  expect(workflowRequiresWorkspaceDirectory(graph)).toBe(true)
  const node = graph.nodes[0]!
  if (node.kind === 'job') throw new Error('Agent fixture required')
  node.artifactOutputs = { version: 1, outputKeys: ['report'] }
  expect(workflowUsesAgentPlacements(graph)).toBe(true)
  expect(workflowRequiresWorkspaceDirectory(graph)).toBe(false)
  graph.nodes.push({ kind: 'job', id: 'build', name: 'Build', jobDefinitionId: 'definition',
    jobDefinitionRevision: 1, jobDefinitionVersionId: 'version' })
  expect(workflowRequiresWorkspaceDirectory(graph)).toBe(true)
})
