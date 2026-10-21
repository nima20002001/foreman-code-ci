import { randomUUID } from 'node:crypto'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

/** A saved hierarchy using the existing single-child handoff protocol. */
export function masterApprovalFixture() {
  const fixture = makeCurrentWorkflowFixture(randomUUID())
  const graph = fixture.version.definition
  const master = graph.nodes[0]!
  const worker = graph.nodes[1]!
  const coordinatorConfiguration = {
    ...fixture.configurations[0]!,
    id: `coordinator-config-${fixture.scope.workflowId}`,
    agentId: `coordinator-agent-${fixture.scope.workflowId}`,
    productRole: 'orchestrator' as const,
  }
  const coordinator = { id: `coordinator-${fixture.scope.workflowId}`,
    agentId: coordinatorConfiguration.agentId, name: 'Orchestrator' }
  fixture.configurations.push(coordinatorConfiguration)
  fixture.version.agentConfigurationVersionIds[coordinator.agentId] = coordinatorConfiguration.id
  graph.nodes.push(coordinator)
  graph.handoffs = { contractVersion: 1 }
  graph.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 3 }
  graph.hierarchy = { version: 1, masterNodeId: master.id, parents: [
    { workflowNodeId: coordinator.id, parentNodeId: master.id },
    { workflowNodeId: worker.id, parentNodeId: coordinator.id },
  ] }
  graph.edges = [
    { id: 'master-request', kind: 'execution', source: master.id, target: coordinator.id },
    { id: 'coordinator-request', kind: 'execution', source: coordinator.id, target: worker.id },
  ]
  for (const edge of graph.edges) {
    const node = graph.nodes.find(candidate => candidate.id === edge.source)!
    node.choice = { outcomes: [{ outcome: 'delegate', target: { kind: 'edge', relationshipId: edge.id } }] }
  }
  return fixture
}

export async function masterApprovalOutput() {
  return JSON.stringify({ routing: { kind: 'request', outcome: 'delegate' },
    data: { latestDeliverable: 'Review the delegated task', remainingFindings: [] },
    summary: 'Delegated the review task.' })
}
