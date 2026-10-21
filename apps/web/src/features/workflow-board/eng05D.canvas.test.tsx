import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { act, renderHook, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Edge, Node, ReactFlowProps } from '@xyflow/react'
import { CurrentRunDetailsSchema, RepeatGraphCurrentV3Schema, WorkflowVersionV3Schema, repeatGraphTopologyV3 } from '@foreman-code/contracts/wave25'
import { currentRunKey } from './currentRunQuery'
import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { WorkflowBoardContext } from './context'
import { useSelectedRunRecord } from './runFacts'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import {
  advanceCurrentSequence, boardHref, currentIdle, installBoardTestLifecycle, intervalTick,
  isCurrentRequest, measureBoardWire, mountMeasuredBoard, openRunDetails, setRunState,
} from './eng05D.testSupport'

// Transparent observation, NOT a fake canvas: retain the actual React Flow,
// its memoized node renderer, virtualization, controls and keyboard handling.
// Frames keep the saved Run nodes apart from the Board's CI server, a presentation component beside them.
const observed = vi.hoisted(() => ({ frames: [] as Array<{ nodes: Node[]; edges: Edge[] }> }))
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const { createElement } = await import('react')
  return { ...actual, ReactFlow: (props: ReactFlowProps) => {
    if (props['aria-label'] === 'Run graph canvas') observed.frames.push({ edges: props.edges ?? [],
      nodes: (props.nodes ?? []).filter((node) => node.type === 'pinnedRunNode') })
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
  // A schema-validated ordinary 400-node sequential workflow with unique
  // node/Agent/configuration pins, not manufactured business repetitions.
  const nodes = Array.from({ length: 400 }, (_, index) => ({ ...first,
    id: index === 0 ? first.id : `scale-node-${index}`, name: `Saved scale node ${index}`,
    agentId: index === 0 ? first.agentId : `scale-agent-${index}`,
    position: { x: (index % 20) * 280, y: Math.floor(index / 20) * 160 } }))
  const pins = Object.fromEntries(nodes.map((node, index) => [node.agentId, index === 0
    ? fixture.before.agentConfigurationVersionIds[first.agentId]! : `scale-config-${index}`]))
  const version = WorkflowVersionV3Schema.parse({ ...fixture.before, agentConfigurationVersionIds: pins,
    definition: { ...fixture.before.definition, nodes,
      edges: nodes.slice(1).map((node, index) => ({ id: `scale-edge-${index}`, kind: 'execution', source: nodes[index]!.id, target: node.id })),
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 400 } } })
  fixture.mock.versions.set(version.id, version)
  const details = fixture.mock.runs.get(scope.runId)!
  fixture.mock.runs.set(scope.runId, CurrentRunDetailsSchema.parse({ ...details, run: { ...details.run, agentConfigurationVersionIds: pins } }))
  const current = fixture.mock.currents.get(scope.runId)!
  fixture.mock.currents.set(scope.runId, RepeatGraphCurrentV3Schema.parse({ ...current, topology: repeatGraphTopologyV3(version) }))
  setRunState(fixture, scope, 'running')
  const wire = measureBoardWire(fixture.mock, (request) => {
    if (isCurrentRequest(request)) advanceCurrentSequence(fixture, scope)
    return undefined
  })
  const mounted = await mountMeasuredBoard(boardHref(scope))
  await currentIdle(mounted.cache, currentRunKey(scope))
  await waitFor(() => {
    const frame = observed.frames.at(-1)
    expect(frame?.nodes).toHaveLength(400)
    expect(frame?.edges).toHaveLength(399)
    expect(frame?.nodes.every((node) => node.data.recorded === 'No activation in the bounded current cut')).toBe(true)
  })
  return { fixture, scope, wire, ...mounted }
}

describe('ENG05-D real pinned canvas scale and invalidation', () => {
  it('keeps one immutable 400-node canvas and exposes every saved node through the accessible inspector', async () => {
    const { scope, wire, cache } = await largeBoard()
    expect(screen.getAllByLabelText('Run graph canvas')).toHaveLength(1)
    const inspector = await openRunDetails()
    const nodePicker = within(inspector).getByRole('combobox', { name: 'Run node' })
    expect(within(nodePicker).getAllByRole('option')).toHaveLength(401)
    expect(within(inspector).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Editable workflow graph')).toHaveAttribute('aria-hidden', 'true')
    const frame = observed.frames.at(-1)!
    const before = observed.frames.length
    // An unrelated cache write must not turn a cache-only current subscriber
    // into a global-canvas render subscription.
    await act(async () => { cache.setQueryData(['eng05d-unrelated'], { value: 1 }) })
    expect(observed.frames).toHaveLength(before)
    expect(observed.frames.at(-1)).toBe(frame)
    expect(new Set(frame.nodes.map((node) => node.id)).size).toBe(400)
    expect(wire.activity()).toHaveLength(0)
    expect(wire.writes()).toHaveLength(0)
    expect(cache.getQueryState(currentRunKey(scope))?.status).toBe('success')
    wire.report('400-node-mounted-canvas')
  }, 30_000)

  it('regression: an activity-only current tick preserves every unchanged node data object and edge', async () => {
    const { scope, wire, cache } = await largeBoard()
    const subscriber = renderHook(() => useSelectedRunRecord(), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={cache}>
        <WorkflowBoardContext.Provider value={{
          workspaceId: scope.workspaceId, workflowId: scope.workflowId, run: scope, inspection: {}, activeRuns: 0,
          selectRun: () => undefined, selectInspection: () => undefined,
          openLocation: () => undefined, openRuns: () => undefined,
        }}>{children}</WorkflowBoardContext.Provider>
      </QueryClientProvider>,
    })
    const board = screen.getByTestId('unified-workflow-board')
    const canvas = screen.getByLabelText('Run graph canvas')
    const before = observed.frames.at(-1)!, frameCount = observed.frames.length
    const requests = wire.current().length
    await intervalTick()
    await waitFor(() => expect(wire.current()).toHaveLength(requests + 1))
    await currentIdle(cache, currentRunKey(scope))
    await waitFor(() => expect(cache.getQueryData<{ asOfSequence: string }>(currentRunKey(scope))?.asOfSequence).toBe('2'))
    await waitFor(() => expect(subscriber.result.current?.asOfSequence).toBe('2'))
    const after = observed.frames.at(-1)!
    const byId = new Map(before.nodes.map((node) => [node.id, node]))
    const changed = after.nodes.filter((node) => node.data !== byId.get(node.id)?.data).map((node) => node.id)
    console.info(`ENG05-D_CANVAS ${JSON.stringify({ nodes: 400, edges: 399,
      additionalReactFlowCalls: observed.frames.length - frameCount, changedNodeDataObjects: changed.length,
      currentResponseBytes: wire.current().at(-1)!.responseBytes })}`)
    expect(screen.getByTestId('unified-workflow-board')).toBe(board)
    expect(screen.getByLabelText('Run graph canvas')).toBe(canvas)
    expect(after.edges).toBe(before.edges)
    expect(wire.activity()).toHaveLength(0)
    expect(wire.writes()).toHaveLength(0)
    // Normative, deliberately not test.fails/skip: 97f9ccd's record-wide memo
    // dependencies appear to recreate all 400 data objects. See README D-01.
    expect(changed, 'Activity-only updates must not invalidate every memoized pinned node').toEqual([])
  }, 30_000)
})
