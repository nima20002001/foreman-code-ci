import { describe, expect, it } from 'vitest'

import { NodeResolutionSchema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { compileExecutionTopology, decideExecutionAdmission } from '../src/modules/runs/topology.js'

function fixture() {
  const f = makeCurrentWorkflowFixture('topology', 'parallel')
  const [entry, left, right, join] = f.version.definition.nodes
  return { ...f, entry: entry!, left: left!, right: right!, join: join! }
}

describe('current LangGraph topology validation', () => {
  it('uses the explicit entry and relationship identities rather than canvas or array position', () => {
    const f = fixture()
    f.entry.position = { x: 900, y: 0 }
    f.left.position = { x: 0, y: 0 }
    f.version.definition.edges.reverse()
    const topology = compileExecutionTopology(WorkflowVersionV3Schema.parse(f.version))
    expect(topology.entryNodeId).toBe(f.entry.id)
    expect(topology.outgoing.get(f.entry.id)?.map((edge) => edge.target)).toEqual([f.left.id, f.right.id])
    expect(topology.incoming.get(f.join.id)?.map((edge) => edge.source)).toEqual([f.left.id, f.right.id])
    expect(topology.sinks).toEqual([f.join.id])
  })

  it.each(['source', 'target'] as const)('rejects an unknown edge %s before building adjacency', (endpoint) => {
    const f = fixture()
    f.version.definition.edges[0]![endpoint] = 'missing-node'
    expect(() => WorkflowVersionV3Schema.parse(f.version)).toThrow('relationships require distinct existing endpoints')
    expect(() => compileExecutionTopology(f.version)).toThrow('invalid identity or endpoints')
  })

  it('retains all-required fan-in when the optional all-join annotation is omitted', () => {
    const f = fixture()
    delete f.join.join
    const topology = compileExecutionTopology(WorkflowVersionV3Schema.parse(f.version))
    expect(topology.incoming.get(f.join.id)?.map((edge) => edge.source)).toEqual([f.left.id, f.right.id])
    const resolutions = new Map<string, ReturnType<typeof NodeResolutionSchema.parse>>()
    expect(decideExecutionAdmission(topology, f.join.id, resolutions)).toEqual({ kind: 'waiting' })
    for (const node of [f.left, f.right]) {
      const selected = topology.outgoing.get(node.id)!.map((edge) => edge.id)
      resolutions.set(node.id, NodeResolutionSchema.parse({ workflowNodeId: node.id, resolution: 'succeeded',
        execution: f.identities.find((identity) => identity.workflowNodeId === node.id),
        acceptedResultDigest: `sha256:${'1'.repeat(64)}`, branchEnded: false,
        selectedRelationshipIds: selected, unselectedRelationshipIds: [], resolvedAt: f.createdAt,
      }))
      expect(decideExecutionAdmission(topology, f.join.id, resolutions)).toEqual(node === f.left
        ? { kind: 'waiting' } : { kind: 'run', selected: topology.incoming.get(f.join.id) })
    }
  })

  it('rejects an excluded predecessor feeding a reachable node', () => {
    const f = fixture()
    f.version.definition.edges = f.version.definition.edges.filter((edge) => !(edge.source === f.entry.id && edge.target === f.right.id))
    expect(() => compileExecutionTopology(f.version)).toThrow('An excluded component cannot supply a selected-component dependency')
  })

  it('rejects an authored cycle instead of treating it as a terminal graph', () => {
    const f = fixture()
    f.version.definition.edges.push({ id: 'back-edge', kind: 'execution', source: f.join.id, target: f.left.id })
    expect(() => WorkflowVersionV3Schema.parse(f.version)).toThrow('execution relationships must form an acyclic graph')
    expect(() => compileExecutionTopology(f.version)).toThrow('only explicit finite block boundaries may repeat')
  })

  it('accepts explicit finite repeat without introducing a back-edge into the DAG', () => {
    const { version } = makeCurrentWorkflowFixture('topology-repeat', 'repeat')
    const topology = compileExecutionTopology(WorkflowVersionV3Schema.parse(version))
    expect(topology.order).toEqual(version.definition.nodes.map((node) => node.id))
    expect(version.definition.repeat?.blocks[0]?.maxOccurrences).toBe(3)
  })

  it('rejects legacy result expressions instead of silently translating them to named choices', () => {
    const { version } = fixture()
    const [edge, ...rest] = version.definition.edges
    const invalid = { ...version, definition: { ...version.definition, edges: [{ ...edge,
      route: { outcomes: ['succeeded'], result: { path: ['approved'], operator: 'equals', value: true } },
    }, ...rest] } }
    expect(() => WorkflowVersionV3Schema.parse(invalid)).toThrow()
    expect(WorkflowVersionV3Schema.safeParse(makeCurrentWorkflowFixture('named-choice', 'conditional').version).success).toBe(true)
  })

  it('accepts repeated Agents with exact pins and rejects a mismatched distinct Agent count', () => {
    const f = fixture()
    expect(() => WorkflowVersionV3Schema.parse(f.version)).not.toThrow()
    const replacedAgentId = f.join.agentId
    f.join.agentId = f.right.agentId
    delete f.version.agentConfigurationVersionIds[replacedAgentId]
    f.version.definition.requiredAgentCount = new Set(f.version.definition.nodes.map((node) => node.agentId)).size
    expect(() => WorkflowVersionV3Schema.parse(f.version)).not.toThrow()
    const other = fixture()
    other.version.definition.requiredAgentCount = other.version.definition.nodes.length - 1
    expect(() => WorkflowVersionV3Schema.parse(other.version)).toThrow('requiredAgentCount does not match the topology')
  })
})
