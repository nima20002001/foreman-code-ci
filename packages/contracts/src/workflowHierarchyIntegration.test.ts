import { describe, expect, it } from 'vitest'
import { WorkflowHierarchyCoordinationSchema, WorkflowHierarchyReadInputSchema, WorkflowHierarchyReadResultSchema,
  WorkflowHierarchyUpdateInputSchema, WorkflowReportsReadInputSchema, isHierarchyReportingRoute } from './workflowHierarchy.js'
import { ExecutableWorkflowV3Schema, WorkflowHierarchyUpdateResultSchema,
  makeCurrentWorkflowFixture, type WorkflowDefinitionV3 } from './wave25/index.js'

function hierarchy() {
  const original = makeCurrentWorkflowFixture('hierarchy-public-contract', 'parallel')
  const configurations = original.configurations.map((configuration, index) => ({ ...configuration,
    productRole: index === 0 ? 'master' as const : index === 1 ? 'orchestrator' as const : 'coder' as const,
  }))
  const ids = original.version.definition.nodes.map(node => node.id)
  const edges = [[0, 1], [1, 2], [1, 3]].map(([from, to], i) => ({ id: `route-${i}`, kind: 'execution' as const,
    source: ids[from!]!, target: ids[to!]! }))
  const definition: WorkflowDefinitionV3 = { ...original.version.definition, handoffs: { contractVersion: 1 },
    hierarchy: { version: 1, masterNodeId: ids[0]!, parents: [
      { workflowNodeId: ids[1]!, parentNodeId: ids[0]! },
      ...ids.slice(2).map(workflowNodeId => ({ workflowNodeId, parentNodeId: ids[1]! })),
    ] }, edges, nodes: original.version.definition.nodes.map(node => {
      const { join: _join, ...plain } = node; void _join
      const routes = edges.filter(edge => edge.source === node.id)
      return { ...plain, ...(routes.length ? { choice: { outcomes: routes.map((edge, i) => ({
        outcome: `child_${i}`, target: { kind: 'edge' as const, relationshipId: edge.id },
      })) } } : {}) }
    }) }
  return { version: { ...original.version, definition }, configurations }
}

describe('hierarchy uses the shared executable boundary', () => {
  it('accepts one directed route for every direct child and multiple aliases to that child', () => {
    const saved = hierarchy()
    expect(ExecutableWorkflowV3Schema.safeParse(saved).success).toBe(true)
    const first = saved.version.definition.nodes[0]!
    first.choice!.outcomes.push({ outcome: 'review_again', target: { ...first.choice!.outcomes[0]!.target } })
    expect(ExecutableWorkflowV3Schema.safeParse(saved).success).toBe(true)
  })
  it('reports hierarchy-only join and interval failures at the exact authored node', () => {
    const saved = hierarchy(), graph = saved.version.definition
    const worker = graph.nodes[2]!
    if (worker.kind === 'job') throw new Error('Expected an Agent fixture')
    graph.nodes[2] = { ...worker, join: { mode: 'all' }, interval: { everySeconds: 300 } }
    const result = ExecutableWorkflowV3Schema.safeParse(saved)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['version', 'definition', 'nodes', 2, 'join'] }),
      expect.objectContaining({ path: ['version', 'definition', 'nodes', 2, 'interval'] }),
    ]))
    const ordinary = makeCurrentWorkflowFixture('ordinary-join-still-supported', 'parallel')
    expect(ExecutableWorkflowV3Schema.safeParse({ version: ordinary.version, configurations: ordinary.configurations }).success).toBe(true)
  })
  it('rejects missing direct-child routes, reversed links and mismatched pinned Master roles', () => {
    const missing = hierarchy()
    missing.version.definition.nodes[0]!.choice = { outcomes: [{ outcome: 'done', target: { kind: 'branch_end' } }] }
    expect(ExecutableWorkflowV3Schema.safeParse(missing).success).toBe(false)
    const reversed = hierarchy(), first = reversed.version.definition.edges[0]!
    reversed.version.definition.edges[0] = { ...first, source: first.target, target: first.source, workRequestDirection: 'both' }
    expect(ExecutableWorkflowV3Schema.safeParse(reversed).success).toBe(false)
    const role = hierarchy()
    role.configurations[0]!.productRole = 'orchestrator'
    expect(ExecutableWorkflowV3Schema.safeParse(role).success).toBe(false)
  })
  it('accepts explicit review routes that return to the entry only for hierarchy handoffs, while the reporting tree remains acyclic', () => {
    const saved = hierarchy(), graph = saved.version.definition
    const master = graph.nodes[0]!, team = graph.nodes[1]!
    graph.edges.push({ id: 'ordinary-review-return', kind: 'execution', source: team.id, target: master.id })
    team.choice!.outcomes.push({ outcome: 'review_return', target: { kind: 'edge', relationshipId: 'ordinary-review-return' } })
    expect(ExecutableWorkflowV3Schema.safeParse(saved).success).toBe(true)
    const ambiguous = structuredClone(saved)
    ambiguous.version.definition.edges[0]!.workRequestDirection = 'both'
    const overlap = ExecutableWorkflowV3Schema.safeParse(ambiguous)
    expect(overlap.success).toBe(false)
    if (!overlap.success) expect(overlap.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'HANDOFF_DUPLICATE_CONNECTION' }),
    ]))
    const ordinary = structuredClone(saved)
    delete ordinary.version.definition.hierarchy
    ordinary.configurations[0]!.productRole = 'orchestrator'
    const worker = graph.nodes[2]!
    ordinary.version.definition.edges = [
      { id: 'ordinary-a', kind: 'execution', source: master.id, target: team.id },
      { id: 'ordinary-b', kind: 'execution', source: team.id, target: worker.id },
      { id: 'ordinary-c', kind: 'execution', source: worker.id, target: master.id },
    ]
    ordinary.version.definition.nodes = ordinary.version.definition.nodes.map(node => { const next = { ...node }; delete next.choice; return next })
    const result = ExecutableWorkflowV3Schema.safeParse(ordinary)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'entry cannot have an incoming execution dependency' }),
      expect.objectContaining({ message: 'execution relationships must form an acyclic graph' }),
    ]))
    graph.hierarchy!.parents[0] = { workflowNodeId: team.id, parentNodeId: team.id }
    expect(ExecutableWorkflowV3Schema.safeParse(saved).success).toBe(false)
  })
})

it('keeps read scope mutually exclusive, bounded report defaults, and accepted command identity domains', () => {
  const scope = { workspaceId: 'workspace', workflowId: 'workflow' }
  expect(WorkflowHierarchyReadInputSchema.safeParse({ ...scope, runId: 'run', workflowVersionId: 'version' }).success).toBe(false)
  expect(WorkflowReportsReadInputSchema.parse({ ...scope, runId: 'run' }).limit).toBe(50)
  expect(WorkflowReportsReadInputSchema.safeParse({ ...scope, runId: 'run', limit: 101 }).success).toBe(false)
  const { version } = hierarchy()
  const input = WorkflowHierarchyUpdateInputSchema.parse({ ...scope, hierarchy: null, commandId: 'save hierarchy 1' })
  const result = WorkflowHierarchyUpdateResultSchema.parse({ value: {
    workspaceId: version.workspaceId, workflowId: version.workflowId, revision: 1, currentVersionId: version.id, version,
  }, replayed: false, commandId: input.commandId })
  expect(result.commandId).toBe('save hierarchy 1')
})

it('requires a real held execution for direction and keeps every root reference on the selected immutable Run', () => {
  const execution = { runId: 'run', workflowVersionId: 'version', activationId: 'held-activation', executionId: 'held-execution', attempt: 1 }
  const coordination = { state: 'waiting_for_direction' as const,
    direction: { directionId: 'direction', activationId: 'held-activation', execution } }
  expect(WorkflowHierarchyCoordinationSchema.safeParse(coordination).success).toBe(true)
  expect(WorkflowHierarchyCoordinationSchema.safeParse({ state: 'waiting_for_direction' }).success).toBe(false)
  expect(WorkflowHierarchyCoordinationSchema.safeParse({ ...coordination, state: 'succeeded' }).success).toBe(false)
  expect(WorkflowHierarchyCoordinationSchema.safeParse({ ...coordination,
    direction: { ...coordination.direction, activationId: 'fabricated-activation' } }).success).toBe(false)
  const read = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version', revision: 1,
    hierarchy: null, agents: [], run: { runId: 'run', state: 'running', coordination } }
  expect(WorkflowHierarchyReadResultSchema.safeParse(read).success).toBe(true)
  expect(WorkflowHierarchyReadResultSchema.safeParse({ ...read, workflowVersionId: 'new-current-version' }).success).toBe(false)
  expect(WorkflowHierarchyReadResultSchema.safeParse({ ...read, run: { ...read.run, runId: 'different-run' } }).success).toBe(false)
})

it('labels only the saved parent-to-child execution direction and leaves approval and sibling routes ordinary', () => {
  const hierarchy = { version: 1 as const, masterNodeId: 'master', parents: [
    { workflowNodeId: 'team', parentNodeId: 'master' }, { workflowNodeId: 'worker', parentNodeId: 'team' },
  ] }
  expect(isHierarchyReportingRoute(hierarchy, { kind: 'execution', source: 'master', target: 'team' })).toBe(true)
  expect(isHierarchyReportingRoute(hierarchy, { kind: 'execution', source: 'team', target: 'worker' })).toBe(true)
  expect(isHierarchyReportingRoute(hierarchy, { kind: 'approval', source: 'master', target: 'team' })).toBe(false)
  expect(isHierarchyReportingRoute(hierarchy, { kind: 'execution', source: 'team', target: 'master' })).toBe(false)
  expect(isHierarchyReportingRoute(hierarchy, { kind: 'execution', source: 'worker', target: 'reviewer' })).toBe(false)
  expect(isHierarchyReportingRoute(undefined, { kind: 'execution', source: 'master', target: 'team' })).toBe(false)
})
