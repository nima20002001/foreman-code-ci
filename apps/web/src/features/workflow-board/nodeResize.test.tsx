import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'
import { nextDraftDirty } from '../graph/nextDraft/state'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { boardHref, setRunState, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard } from './eng05D.testSupport'

const observed = vi.hoisted(() => ({ flow: undefined as import('@xyflow/react').ReactFlowProps | undefined }))
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const { createElement } = await import('react')
  return { ...actual, ReactFlow: (props: import('@xyflow/react').ReactFlowProps) => {
    if (props['aria-label'] === 'Run graph canvas') observed.flow = props
    return createElement(actual.ReactFlow, props)
  } }
})

installBoardTestLifecycle()

it('resizes an active Run node through layout Save and shows the persisted circle on the draft and Run', async () => {
  installFlowLayout(1000, 720)
  const fixture = await inspectionBoardFixture('circle-resize')
  const scope = fixture.runs.before.scope
  setRunState(fixture, scope, 'running')
  const originalVersion = structuredClone(fixture.mock.versions.get(scope.workflowVersionId))
  const originalRun = structuredClone(fixture.mock.runs.get(scope.runId))
  const wire = measureBoardWire(fixture.mock)
  const { history, container } = await mountMeasuredBoard(boardHref(scope))
  const label = fixture.first.name ?? fixture.first.label ?? fixture.first.id
  const ring = await screen.findByRole('slider', { name: `Resize ${label}` })
  expect(ring).toHaveAttribute('tabindex', '0')
  const initial = Number(ring.getAttribute('aria-valuenow'))
  fireEvent.keyDown(ring, { key: 'ArrowRight' })
  await waitFor(() => expect(ring).toHaveAttribute('aria-valuenow', String(initial + 8)))
  const key = nextDraftKey(scope.workspaceId, scope.workflowId)
  await waitFor(() => {
    expect(useGraphDraftStore.getState().nextDrafts[key]!.context.draft.graph.nodes[0]).toMatchObject({
      width: initial + 8, height: initial + 8,
    })
  })
  expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
  expect(wire.writes()).toHaveLength(1)
  expect(wire.writes()[0]).toMatchObject({ method: 'PUT', status: 200 })
  expect(fixture.mock.workflows.get(scope.workflowId)!.nodes[0]).toMatchObject({ width: initial + 8, height: initial + 8 })
  expect(fixture.mock.versions.get(scope.workflowVersionId)).toEqual(originalVersion)
  expect(fixture.mock.runs.get(scope.runId)).toEqual(originalRun)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /^Runs$/ }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'New run' }))
  const draftRing = await screen.findByRole('slider', { name: `Resize ${label}` })
  expect(draftRing).toHaveAttribute('aria-valuenow', String(initial + 8))
  expect(container.querySelector('.react-flow__resize-control')).toBeNull()
  await history.back()
  await waitFor(() => expect(screen.getByLabelText('Selected Run pinned topology')).toBeInTheDocument())
  expect(await screen.findByRole('slider', { name: `Resize ${label}` })).toHaveAttribute('aria-valuenow', String(initial + 8))
}, 15_000)

it('moves an active Run node through presentation Save without changing the Run or version', async () => {
  installFlowLayout(1000, 720)
  const fixture = await inspectionBoardFixture('active-node-move')
  const scope = fixture.runs.before.scope
  setRunState(fixture, scope, 'running')
  const originalVersion = structuredClone(fixture.mock.versions.get(scope.workflowVersionId))
  const originalRun = structuredClone(fixture.mock.runs.get(scope.runId))
  const wire = measureBoardWire(fixture.mock)
  await mountMeasuredBoard(boardHref(scope))
  const label = fixture.first.name ?? fixture.first.label ?? fixture.first.id
  await screen.findByRole('slider', { name: `Resize ${label}` })
  expect(observed.flow?.nodesDraggable).toBe(true)
  expect(observed.flow?.nodesConnectable).toBe(false)
  const node = observed.flow!.nodes!.find((node) => node.id === fixture.first.id)!
  expect(node.draggable).toBe(true)
  const position = { x: 500, y: 320 }
  act(() => observed.flow!.onNodesChange!([{ id: node.id, type: 'position', position, dragging: true }]))
  expect(observed.flow!.nodes!.find((item) => item.id === node.id)!.position).toEqual(position)
  expect(wire.writes()).toHaveLength(0)
  // React Flow can end a drag without repeating the final position.
  act(() => observed.flow!.onNodesChange!([{ id: node.id, type: 'position', dragging: false }]))
  const key = nextDraftKey(scope.workspaceId, scope.workflowId)
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]!.context.draft.graph.nodes[0])
    .toMatchObject({ position }))
  expect(wire.writes()).toHaveLength(1)
  expect(wire.writes()[0]).toMatchObject({ method: 'PUT', status: 200 })
  expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
  expect(fixture.mock.workflows.get(scope.workflowId)!.nodes[0]).toMatchObject({ position })
  expect(fixture.mock.versions.get(scope.workflowVersionId)).toEqual(originalVersion)
  expect(fixture.mock.runs.get(scope.runId)).toEqual(originalRun)
}, 15_000)

it('selects and drags an active Run node with the pointer and saves the layout silently', async () => {
  installFlowLayout(1000, 720)
  const fixture = await inspectionBoardFixture('active-node-pointer')
  const scope = fixture.runs.before.scope
  setRunState(fixture, scope, 'running')
  const originalVersion = structuredClone(fixture.mock.versions.get(scope.workflowVersionId))
  const originalRun = structuredClone(fixture.mock.runs.get(scope.runId))
  const wire = measureBoardWire(fixture.mock)
  const { container } = await mountMeasuredBoard(boardHref(scope))
  const label = fixture.first.name ?? fixture.first.label ?? fixture.first.id
  await screen.findByRole('slider', { name: `Resize ${label}` })
  const node = container.querySelector<HTMLElement>(`.pinned-run-canvas .react-flow__node[data-id="${fixture.first.id}"]`)!
  const before = node.style.transform
  const core = node.querySelector<HTMLElement>('.n-agent-core')!
  const view = core.ownerDocument.defaultView!
  const pointer = (type: string, x: number, y: number) => {
    const event = new view.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 })
    Object.defineProperty(event, 'view', { value: view }) // jsdom leaves it null; d3-drag listens on it.
    return event
  }
  act(() => { core.dispatchEvent(pointer('mousedown', 100, 100)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 160, 150)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 220, 200)) })
  act(() => { view.dispatchEvent(pointer('mouseup', 220, 200)) })
  expect(node).toHaveClass('selected')
  expect(node.style.transform).not.toBe(before)
  await waitFor(() => expect(wire.writes()).toHaveLength(1))
  expect(wire.writes()[0]).toMatchObject({ method: 'PUT', status: 200 })
  const key = nextDraftKey(scope.workspaceId, scope.workflowId)
  await waitFor(() => expect(fixture.mock.workflows.get(scope.workflowId)!.nodes[0]!.position)
    .toEqual(useGraphDraftStore.getState().nextDrafts[key]!.context.draft.graph.nodes[0]!.position))
  expect(fixture.mock.workflows.get(scope.workflowId)!.nodes[0]!.position).not.toEqual(originalVersion?.definition.nodes[0]?.position)
  expect(fixture.mock.versions.get(scope.workflowVersionId)).toEqual(originalVersion)
  expect(fixture.mock.runs.get(scope.runId)).toEqual(originalRun)
  expect(screen.queryByText('Positions are retained locally.')).not.toBeInTheDocument()
}, 15_000)
