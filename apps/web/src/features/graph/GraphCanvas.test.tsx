import { act, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import type { ReactFlowProps } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas'
import { GraphPresentationProvider } from './GraphPresentation'
import { makeScaleGraph } from './fixtures/scaleData'
import { createGraphTopologyProjector } from './topology'
import type { GraphNode, GraphEdge } from './types'

const flow = vi.hoisted(() => ({ props: null as ReactFlowProps<GraphNode, GraphEdge> | null }))
// This isolates gesture wiring. The standalone scale fixture uses the real renderer.
vi.mock('@xyflow/react', async () => ({
  ...await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react'),
  ReactFlow: (props: ReactFlowProps<GraphNode, GraphEdge>) => { flow.props = props; return <div /> },
  Background: () => null, Controls: () => null,
}))
vi.mock('./GraphElements', () => ({ AgentNode: () => null, AgentMinimapDot: () => null, HandoffEdge: () => null }))

function setup(readOnly = false) {
  const { workflow, agents } = makeScaleGraph(3)
  const topology = createGraphTopologyProjector()(workflow, agents)
  const geometryRef = createRef<GraphCanvasHandle>()
  const start = vi.fn(), commit = vi.fn(), cancel = vi.fn()
  const mounted = render(<GraphPresentationProvider><GraphCanvas topology={topology}
    departing={{ nodes: [], edges: [] }} geometryRef={geometryRef} readOnly={readOnly}
    onGeometryStart={start} onGeometryCommit={commit} onGeometryCancel={cancel} /></GraphPresentationProvider>)
  const begin = () => act(() => flow.props!.onNodeDragStart?.({} as never, topology.nodes[0], [topology.nodes[0]]))
  const move = (x: number, dragging: boolean | undefined = true) => act(() => flow.props!.onNodesChange?.([
    { type: 'position', id: topology.nodes[0].id, position: { x, y: 91 }, dragging },
  ]))
  return { ...mounted, topology, geometryRef, start, commit, cancel, begin, move }
}

describe('canvas geometry boundary', () => {
  it('writes no draft callback during pointer moves and preserves the final pointer position on explicit flush', () => {
    const view = setup()
    view.begin()
    for (let x = 1; x <= 50; x++) view.move(x)
    expect(view.commit).not.toHaveBeenCalled()
    expect(view.start.mock.calls).toEqual([[false], [true]])
    expect(view.geometryRef.current!.getNodes()[1]).toBe(view.topology.nodes[1])
    act(() => view.geometryRef.current!.flush())
    expect(view.commit).toHaveBeenCalledExactlyOnceWith([{ id: 'synthetic-node-0', position: { x: 50, y: 91 } }])
    view.unmount()
    expect(view.commit).toHaveBeenCalledTimes(1)
  })

  it('handles a terminal position-less event and a duplicate drag-stop without a second commit', () => {
    const view = setup()
    view.begin(); view.move(123)
    act(() => flow.props!.onNodesChange?.([{ type: 'position', id: 'synthetic-node-0', dragging: false }]))
    const last = view.geometryRef.current!.getNodes()[0]
    act(() => flow.props!.onNodeDragStop?.({} as never, last, [last]))
    expect(view.commit).toHaveBeenCalledTimes(1)
    expect(view.commit.mock.calls[0][0][0].position.x).toBe(123)
    view.unmount()
  })

  it('flushes locally on navigation and never double-commits on unmount', () => {
    const view = setup()
    view.begin(); view.move(222)
    act(() => window.dispatchEvent(new Event('beforeunload')))
    expect(view.commit.mock.calls[0][0][0].position.x).toBe(222)
    view.unmount()
    expect(view.commit).toHaveBeenCalledTimes(1)
  })

  it('cancels an Escape gesture and ignores its trailing pointer events', () => {
    const view = setup()
    view.begin(); view.move(333)
    fireEvent.keyDown(view.container.querySelector('.graph-render-adapter')!, { key: 'Escape' })
    view.move(444)
    act(() => flow.props!.onNodesChange?.([{ type: 'position', id: 'synthetic-node-0', dragging: false }]))
    expect(view.commit).not.toHaveBeenCalled()
    expect(view.cancel).toHaveBeenCalledTimes(1)
    view.begin(); view.move(555)
    act(() => view.geometryRef.current!.flush())
    expect(view.commit.mock.calls[0][0][0].position.x).toBe(555)
    view.unmount()
  })

  it('disables geometry writes on the read-only Run mount', () => {
    const view = setup(true)
    view.begin(); view.move(123)
    act(() => view.geometryRef.current!.flush())
    expect(flow.props!.nodesDraggable).toBe(false)
    expect(flow.props!.nodesConnectable).toBe(false)
    expect(view.start).not.toHaveBeenCalled()
    expect(view.commit).not.toHaveBeenCalled()
    view.unmount()
  })
})
