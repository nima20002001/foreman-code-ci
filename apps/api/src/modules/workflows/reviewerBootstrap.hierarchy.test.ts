import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { validateReviewerBootstrap } from './reviewerBootstrap.js'

it('keeps the accepted entry coordinator available when hierarchy work routes can return to it', () => {
  const fixture = makeCurrentWorkflowFixture('entry-coordinator-request-routes', 'approval')
  const original = fixture.version.definition, entry = original.nodes[0]!, team = original.nodes[1]!
  const definition: WorkflowDefinitionV3 = { ...original, handoffs: { contractVersion: 1 },
    hierarchy: { version: 1, masterNodeId: entry.id, parents: [{ workflowNodeId: team.id, parentNodeId: entry.id }] },
    edges: [...original.edges, { id: 'retained-request-route', kind: 'execution', source: team.id, target: entry.id }],
  }
  const configuration = fixture.configurations[0]!.harness
  expect(() => validateReviewerBootstrap(definition, fixture.version.approval, configuration, entry.id)).not.toThrow()
  expect(() => validateReviewerBootstrap(definition, fixture.version.approval, configuration, team.id)).toThrow('authored entry')
  const ordinary = { ...definition }; delete ordinary.hierarchy
  expect(() => validateReviewerBootstrap(ordinary, fixture.version.approval, configuration, entry.id)).toThrow('incoming automatic execution dependency')
})
