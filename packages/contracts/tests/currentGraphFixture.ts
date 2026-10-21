import { makeCurrentWorkflowFixture, type CurrentFixtureForm } from '../src/wave25/currentFixture.js'
import { RunGraphSnapshotSchema } from '../src/wave25/protocol.js'

/** Current semantics fixture for graph-wire assertions; no native or SQL claim. */
export function makeCurrentGraphFixture(suffix = 'graph-wire', form: CurrentFixtureForm = 'sequential') {
  const fixture = makeCurrentWorkflowFixture(suffix, form)
  const snapshot = RunGraphSnapshotSchema.parse({
    protocolVersion: 1, scope: fixture.scope, asOfSequence: '0', retentionFloor: '0',
    historyCoverage: 'from_admission',
    topology: {
      entryNodeId: fixture.version.entryNodeId,
      nodes: fixture.version.definition.nodes.map((node) => ({ workflowNodeId: node.id, agentId: node.agentId,
        agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[node.agentId],
        productRole: fixture.configurations.find((configuration) => configuration.agentId === node.agentId)?.productRole ?? 'unknown' })),
      relationships: fixture.version.definition.edges.map((edge) => ({ relationshipId: edge.id,
        kind: edge.kind, source: edge.source, target: edge.target })),
    },
    state: { run: { executionState: 'queued', outcome: 'pending', stopRequested: false, cleanupPending: false,
      unsettledReviewCount: 0, pendingInteractionCount: 0 },
      nodes: fixture.version.definition.nodes.map((node) => ({ state: { workflowNodeId: node.id, lifecycle: 'not_activated' },
        activity: { workflowNodeId: node.id, status: 'none' }, attention: { workflowNodeId: node.id,
          pendingInteractionCount: 0, unsettledReviewCount: 0, cleanupPending: false, telemetry: 'current' } })),
      inputBindings: [], interactions: [], reviews: [] },
  })
  return { ...fixture, snapshot }
}
