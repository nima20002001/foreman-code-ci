import { randomUUID } from 'node:crypto'
import { AgentConfigurationVersionSchema, COORDINATION_RESULT_PROTOCOL,
  type HarnessExecutionRequest } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema,
  type WorkActivationInput, type WorkHandoffResult } from '@foreman-code/contracts/wave25'

export const hierarchyChildren = {
  master: ['build', 'test', 'bugs'], build: ['builder'], test: ['tester'], bugs: ['inspector'],
} as const

/** Seven saved nodes require eleven business activations when each coordinator
 * delegates once and then summarizes its actual child results. */
export function hierarchyRuntimeFixture(options: { maximum?: number; siblingReview?: boolean;
  routeMaximum?: number } = {}) {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  const names = ['master', 'build', 'test', 'bugs', 'builder', 'tester', 'inspector'] as const
  const original = fixture.configurations[0]!
  fixture.configurations = names.map((name, index) => AgentConfigurationVersionSchema.parse({ ...original,
    id: `${original.id}-${name}`, agentId: `${original.agentId}-${name}`,
    productRole: index === 0 ? 'master' : index < 4 ? 'orchestrator' : 'coder',
  }))
  const edges = Object.entries(hierarchyChildren).flatMap(([parent, children]) => children.map(child => ({
    id: `route-${parent}-${child}`, kind: 'execution' as const, source: parent, target: child,
    ...(options.routeMaximum === undefined ? {} : { maxWorkHandoffsPerRun: options.routeMaximum }),
  })))
  if (options.siblingReview) edges.push({ id: 'route-builder-tester', kind: 'execution', source: 'builder', target: 'tester' })
  const nodes = names.map((name, index) => {
    const routes = edges.filter(edge => edge.source === name)
    return { id: name, agentId: fixture.configurations[index]!.agentId, name,
      ...(routes.length ? { choice: { outcomes: routes.map(edge => ({
        outcome: edge.id === 'route-builder-tester' ? 'review' : edge.target,
        target: { kind: 'edge' as const, relationshipId: edge.id },
      })) } } : {}) }
  })
  fixture.version = { ...fixture.version, entryNodeId: 'master',
    agentConfigurationVersionIds: Object.fromEntries(fixture.configurations.map(config => [config.agentId, config.id])),
    definition: { ...fixture.version.definition, entryNodeId: 'master', nodes, edges,
      handoffs: { contractVersion: 1 }, executionPolicy: { maxParallelism: 3, maxNodeExecutions: options.maximum ?? 11 },
      hierarchy: { version: 1, masterNodeId: 'master', parents: Object.entries(hierarchyChildren)
        .flatMap(([parentNodeId, children]) => children.map(workflowNodeId => ({ workflowNodeId, parentNodeId }))) },
    } }
  fixture.run = { ...fixture.run, resultProtocol: COORDINATION_RESULT_PROTOCOL,
    agentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
    input: { task: 'Implement and review the saved workflow' } }
  return fixture
}

export function coordinationOutput(nodeId: string, request: HarnessExecutionRequest,
  options: { select?: readonly string[]; findings?: WorkHandoffResult['data']['remainingFindings']; outcome?: 'accepted' | 'needs_changes' } = {}) {
  const input = WorkActivationInputSchema.parse(request.input)
  const children = hierarchyChildren[nodeId as keyof typeof hierarchyChildren]
  const selected = options.select ?? children
  const routing = input.work.kind !== 'hierarchy_group' && selected?.length
    ? { kind: 'delegate' as const, requests: selected.map(outcome => ({ outcome, data: { task: `Task for ${outcome}` } })) }
    : nodeId === 'master' ? { kind: 'finish' as const }
    : { kind: 'return' as const, requestId: receivedRequest(input), outcome: options.outcome ?? 'accepted' }
  return { routing, data: { latestDeliverable: { completedBy: nodeId }, remainingFindings: options.findings ?? [] },
    summary: `${nodeId} ${routing.kind}`, board: { kind: 'none' as const,
      reason: request.configuration.graphqlTools?.some(tool => tool.startsWith('memory_'))
        ? 'no_changes' as const : 'no_access' as const } }
}

export function receivedRequest(input: WorkActivationInput): string {
  const request = input.parentRequest ?? (input.work.kind === 'work_request' ? input.work.request : undefined)
  if (!request) throw new Error('A subordinate result must answer its actual received request')
  return request.requestId
}
