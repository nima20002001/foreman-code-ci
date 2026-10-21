import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Edge, Node, ReactFlowProps } from '@xyflow/react'
import { CurrentRunDetailsSchema, RepeatGraphCurrentV3Schema, WorkflowVersionV3Schema, repeatGraphTopologyV3 } from '@foreman-code/contracts/wave25'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import {
  boardHref, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, openRunDetails, setRunState,
} from './eng05D.testSupport'

// Transparent observation, NOT a fake canvas: retain the actual React Flow,
// its memoized node renderer, virtualization, controls and keyboard handling.
// Frames keep the saved Run nodes apart from the Board's CI server, a presentation component beside them.
const observed = vi.hoisted(() => ({ frames: [] as Array<{ nodes: Node[]; edges: Edge[] }> }))
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const { createElement } = await import('react')
  return { ...actual, ReactFlow: (props: ReactFlowProps) => {
    if (props['aria-label'] === 'Saved Run graph') observed.frames.push({ edges: props.edges ?? [],
      nodes: (props.nodes ?? []).filter((node) => node.type === 'savedBoardNode') })
    return createElement(actual.ReactFlow, props)
  } }
})

installBoardTestLifecycle()
let serial = 0
beforeEach(() => { observed.frames.length = 0 })

async function largeBoard() {
  const fixture = await inspectionBoardFixture(`eng05d-scale-${++serial}`)
  const scope = fixture.runs.before.scope
  const first = nativeNode(fixture.before.definition.nodes[0]!)
  // A schema-validated ordinary 200-node sequential workflow with unique
  // node/Agent/configuration pins, not manufactured business repetitions.
  const nodes = Array.from({ length: 200 }, (_, index) => ({ ...first,
    id: index === 0 ? first.id : `scale-node-${index}`, name: `Saved scale node ${index}`,
    agentId: index === 0 ? first.agentId : `scale-agent-${index}`,
    position: { x: (index % 20) * 280, y: Math.floor(index / 20) * 160 } }))
  const pins = Object.fromEntries(nodes.map((node, index) => [node.agentId, index === 0
    ? fixture.before.agentConfigurationVersionIds[first.agentId]! : `scale-config-${index}`]))
  const version = WorkflowVersionV3Schema.parse({ ...fixture.before, agentConfigurationVersionIds: pins,
    definition: { ...fixture.before.definition, nodes,
      edges: nodes.slice(1).map((node, index) => ({ id: `scale-edge-${index}`, kind: 'execution', source: nodes[index]!.id, target: node.id })),
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 200 } } })
  fixture.mock.versions.set(version.id, version)
  const details = fixture.mock.runs.get(scope.runId)!
  fixture.mock.runs.set(scope.runId, CurrentRunDetailsSchema.parse({ ...details, run: { ...details.run, agentConfigurationVersionIds: pins } }))
  const current = fixture.mock.currents.get(scope.runId)!
  fixture.mock.currents.set(scope.runId, RepeatGraphCurrentV3Schema.parse({ ...current, topology: repeatGraphTopologyV3(version) }))
  setRunState(fixture, scope, 'running')
  const wire = measureBoardWire(fixture.mock)
  const mounted = await mountMeasuredBoard(boardHref(scope))
  await waitFor(() => {
    const frame = observed.frames.at(-1)
    expect(frame?.nodes).toHaveLength(200)
    expect(frame?.edges).toHaveLength(199)
  })
  return { fixture, scope, wire, ...mounted }
}

describe('ENG05-D real saved Run canvas scale and invalidation', () => {
  it('keeps one immutable 200-node canvas and exposes every saved node through the accessible inspector', async () => {
    const { wire, cache } = await largeBoard()
    expect(screen.getAllByLabelText('Saved Run graph')).toHaveLength(1)
    const inspector = await openRunDetails()
    const nodePicker = within(inspector).getByRole('combobox', { name: 'Run node' })
    expect(within(nodePicker).getAllByRole('option')).toHaveLength(201)
    expect(within(inspector).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Workflow authoring', hidden: true })).not.toBeVisible()
    const frame = observed.frames.at(-1)!
    const before = observed.frames.length
    // An unrelated cache write must not turn a cache-only current subscriber
    // into a global-canvas render subscription.
    await act(async () => { cache.setQueryData(['eng05d-unrelated'], { value: 1 }) })
    expect(observed.frames).toHaveLength(before)
    expect(observed.frames.at(-1)).toBe(frame)
    expect(new Set(frame.nodes.map((node) => node.id)).size).toBe(200)
    expect(wire.activity()).toHaveLength(0)
    expect(wire.writes()).toHaveLength(0)
    wire.report('200-node-mounted-canvas')
  }, 30_000)

  it('regression: a Run snapshot refresh with unchanged facts preserves every node data object and edge', async () => {
    const { wire, cache } = await largeBoard()
    const board = screen.getByTestId('unified-workflow-board')
    const canvas = screen.getByLabelText('Saved Run graph')
    const before = observed.frames.at(-1)!
    const reads = wire.samples.filter((sample) => sample.path.endsWith('/snapshot')).length
    await act(async () => { await cache.invalidateQueries({ queryKey: ['runs-selector', 'snapshot'] }) })
    await waitFor(() => expect(wire.samples.filter((sample) => sample.path.endsWith('/snapshot')).length).toBeGreaterThan(reads))
    await waitFor(() => expect(cache.isFetching()).toBe(0))
    const after = observed.frames.at(-1)!
    const byId = new Map(before.nodes.map((node) => [node.id, node]))
    const changed = after.nodes.filter((node) => node.data !== byId.get(node.id)?.data).map((node) => node.id)
    expect(screen.getByTestId('unified-workflow-board')).toBe(board)
    expect(screen.getByLabelText('Saved Run graph')).toBe(canvas)
    expect(after.nodes).toHaveLength(200)
    expect(after.edges.map((edge) => edge.id)).toEqual(before.edges.map((edge) => edge.id))
    expect(wire.activity()).toHaveLength(0)
    expect(wire.writes()).toHaveLength(0)
    expect(changed, 'An unchanged snapshot must not invalidate every memoized saved node').toEqual([])
  }, 30_000)
})
