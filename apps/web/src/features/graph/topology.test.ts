import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { describe, expect, it, vi } from 'vitest'
import { createGraphTopologyProjector } from './topology'
import { workflowToGraph } from './mapper'
import { makeScaleGraph } from './fixtures/scaleData'

describe('stable graph topology (reference assertions, not a renderer benchmark)', () => {
  it('does not call the geometry/handle mapper for runtime-only Agent changes', () => {
    const source = makeScaleGraph(300)
    const project = vi.fn(workflowToGraph)
    const reconcile = createGraphTopologyProjector(project)
    const before = reconcile(source.workflow, source.agents)
    const updated = source.agents.map((agent, index) => index === 12 ? {
      ...agent, executionState: 'working' as const, activeRunId: 'run', updatedAt: '2026-09-21T00:00:00Z',
      harnessSummary: { status: 'running' as const },
    } : agent)
    expect(reconcile(source.workflow, updated)).toBe(before)
    expect(project).toHaveBeenCalledTimes(1)
    expect(nativeNode(before.nodes[12]).data.agent.executionState).toBeUndefined()
  })

  it('retains every unaffected node, position and edge after one authored node change', () => {
    const { workflow, agents } = makeScaleGraph(300)
    const reconcile = createGraphTopologyProjector()
    const before = reconcile(workflow, agents)
    const changed = { ...workflow, nodes: workflow.nodes.map((node, index) => index === 10
      ? { ...node, name: 'Renamed Worker' } : node) }
    const after = reconcile(changed, agents)
    expect(nativeNode(after.nodes[10])).not.toBe(nativeNode(before.nodes[10]))
    expect(nativeNode(after.nodes[10]).position).toBe(nativeNode(before.nodes[10]).position)
    after.nodes.forEach((node, index) => { if (index !== 10) expect(node).toBe(nativeNode(before.nodes[index])) })
    expect(after.edges).toBe(before.edges)
  })

  it('keeps unchanged metadata objects and labels while excluding harness status', () => {
    const { workflow, agents } = makeScaleGraph(2)
    const reconcile = createGraphTopologyProjector()
    agents[0] = { ...agents[0], harnessSummary: { status: 'ready', label: 'Local harness' } }
    const before = reconcile(workflow, agents)
    const after = reconcile(workflow, [{ ...agents[0], harnessSummary: { status: 'running', label: 'Local harness' } }, agents[1]])
    expect(after).toBe(before)
    expect(nativeNode(after.nodes[0]).data.harnessLabel).toBe('Local harness')
    expect(nativeNode(after.nodes[0]).data.agent.harnessSummary).toBeUndefined()
  })

  it('explicitly drops wider legacy runtime/selection/cue options', () => {
    const { workflow, agents } = makeScaleGraph(2)
    const project = vi.fn(workflowToGraph)
    const reconcile = createGraphTopologyProjector(project)
    const actions = { onRemoveEdge: vi.fn(), runActive: true, selectedNodeIds: new Set([nativeNode(workflow.nodes[0]).id]),
      enteringNodeIds: new Set([nativeNode(workflow.nodes[0]).id]) }
    const before = reconcile(workflow, agents, actions)
    expect(nativeNode(before.nodes[0]).selected).toBe(false)
    expect(nativeNode(before.nodes[0]).data.entering).toBeUndefined()
    expect(nativeNode(before.nodes[0]).data.runActive).toBeUndefined()
    expect(reconcile(workflow, agents, { ...actions, runActive: false } as typeof actions)).toBe(before)
    expect(project).toHaveBeenCalledTimes(1)
  })

  it('reconciles edge records by ID across ordering and retains complete no-op arrays', () => {
    const { workflow, agents } = makeScaleGraph(4)
    const reconcile = createGraphTopologyProjector()
    const before = reconcile(workflow, agents)
    const noOp = reconcile({ ...workflow, nodes: [...workflow.nodes], edges: [...workflow.edges] }, [...agents])
    expect(noOp).toBe(before)
    const reordered = reconcile({ ...workflow, edges: [...workflow.edges].reverse() }, agents)
    expect(reordered.nodes).toBe(before.nodes)
    expect(reordered.edges[0]).toBe(before.edges[2])
  })

  it('keeps a manually placed node where the person put it and re-aims only its incident edges', () => {
    const { workflow, agents } = makeScaleGraph(4)
    const reconcile = createGraphTopologyProjector()
    const before = reconcile(workflow, agents)
    const after = reconcile({ ...workflow, nodes: workflow.nodes.map((node, index) => index === 0
      ? { ...node, position: { x: 300, y: 500, manual: true } } : node) }, agents)
    expect(nativeNode(after.nodes[0]).position).toEqual({ x: 300, y: 500 })
    expect(before.edges[0].sourceHandle).toBe('bottom')
    expect(after.edges[0].sourceHandle).toBe('left')
    expect(after.edges[0]).not.toBe(before.edges[0])
    expect(after.edges[1]).toBe(before.edges[1])
    expect(after.edges[2]).toBe(before.edges[2])
    expect(nativeNode(after.nodes[1])).toBe(nativeNode(before.nodes[1]))
    expect(nativeNode(after.nodes[2])).toBe(nativeNode(before.nodes[2]))
    expect(nativeNode(after.nodes[3])).toBe(nativeNode(before.nodes[3]))
  })

  it('hierarchy-places absent and legacy positions while preserving manual placement', () => {
    const { workflow, agents } = makeScaleGraph(4)
    const unplaced = { ...workflow, nodes: workflow.nodes.map((node, index) => {
      if (index === 1) return { ...node, position: { x: 900, y: 900, manual: true } }
      if (index !== 3) return node
      const copy = { ...node }
      delete copy.position
      return copy
    }) }
    const automatic = { ...workflow, nodes: workflow.nodes.map((node) => {
      const copy = { ...node }
      delete copy.position
      return copy
    }) }
    const hierarchy = createGraphTopologyProjector()(automatic, agents).nodes
    const nodes = createGraphTopologyProjector()(unplaced, agents).nodes.map(nativeNode)
    expect(nodes[1]!.position).toEqual({ x: 900, y: 900 })
    expect(new Set(nodes.filter((_, index) => index !== 1).map((node) => `${node.position.x},${node.position.y}`)).size).toBe(3)
    for (const index of [0, 2, 3]) expect(nodes[index]!.position).toEqual(hierarchy[index]!.position)
    expect(nodes[2]!.position.y).toBeGreaterThan(nodes[0]!.position.y)
    expect(nodes[3]!.position.y).toBeGreaterThan(nodes[2]!.position.y)
  })
})
