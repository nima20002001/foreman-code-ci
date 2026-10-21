import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { installFlowLayout } from '../../run-board/testFlowLayout'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { DraftCanvas } from './DraftCanvas'
import { nextDraftKey } from './state'

const key = nextDraftKey('workspace', 'workflow')
const stacked = [{ x: 0, y: 0 }, { x: 320, y: 180 }, { x: 320, y: 360 }, { x: 320, y: 540 }]
/** A coordinator and three children; `saved` decides which of them carry a saved position. */
function contextWith(saved: readonly boolean[]) {
  const context = fixture(['coder', 'coder', 'coder', 'coder'])
  context.draft.graph.nodes.forEach((node, index) => {
    if (saved[index]) node.position = stacked[index]!; else delete node.position
  })
  return context
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useGraphDraftStore.getState().clearAllDrafts() })

const placed = (id: string) => {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
  const [, x, y] = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node.style.transform)!
  return { x: Number(x), y: Number(y) }
}
function mount(context: ReturnType<typeof contextWith>, geometry = vi.fn()) {
  useGraphDraftStore.getState().installNextDraft(key, structuredClone(context))
  render(<QueryClientProvider client={new QueryClient()}><GraphPresentationProvider><ReactFlowProvider><DraftCanvas draftKey={key} graph={context.draft.graph}
    agents={context.agents.map((item) => item.agent)} kind="execution" change={vi.fn()} geometry={geometry}
    pending={vi.fn()} report={vi.fn()} /></ReactFlowProvider></GraphPresentationProvider></QueryClientProvider>)
  return geometry
}

it('draws nodes that have no saved position as a hierarchy, not a column', async () => {
  mount(contextWith([false, false, false, false]))
  await screen.findByRole('button', { name: /^Node 3, / })
  const entry = placed('node-0'), children = ['node-1', 'node-2', 'node-3'].map(placed)
  expect(new Set(children.map((point) => point.y)).size).toBe(1)
  expect(new Set(children.map((point) => point.x)).size).toBe(3)
  expect(children[0]!.y).toBeGreaterThan(entry.y)
})

it('keeps a manually placed node and hierarchy-places the remaining nodes', async () => {
  const context = contextWith([false, true, false, false])
  Object.assign(context.draft.graph.nodes[1]!, { position: { ...stacked[1]!, manual: true } })
  mount(context)
  await screen.findByRole('button', { name: /^Node 3, / })
  expect(placed('node-1')).toEqual(stacked[1])
  expect(placed('node-2').y).toBe(placed('node-3').y)
  expect(placed('node-2').y).toBeGreaterThan(placed('node-0').y)
})

it('lets the person drag a node and hands its new position to the geometry save', async () => {
  installFlowLayout(1000, 720)
  const geometry = mount(contextWith([true, true, true, true]))
  await screen.findByRole('button', { name: /^Node 1, / })
  const node = document.querySelector<HTMLElement>('.react-flow__node[data-id="node-1"]')!
  const before = placed('node-1')
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
  await waitFor(() => expect(geometry).toHaveBeenCalledTimes(1))
  const [change] = geometry.mock.calls[0]![0] as { id: string; position: { x: number; y: number } }[]
  expect(change!.id).toBe('node-1')
  expect(change!.position.x).toBeGreaterThan(before.x)
  expect(change!.position.y).toBeGreaterThan(before.y)
  expect(placed('node-1')).toEqual(change!.position)
})
