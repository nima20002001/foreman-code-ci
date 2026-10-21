import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import canvasStyles from './nextDraft.css?inline'
import { GraphPresentationProvider } from '../GraphPresentation'
import { applyGraphGeometry, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { installFlowLayout } from '../../run-board/testFlowLayout'
import { fixture } from './core.cases'
import { DraftCanvas } from './DraftCanvas'
import { nextDraftKey } from './state'

const key = nextDraftKey('workspace', 'workflow'), context = fixture()
const geometry = vi.fn(), change = vi.fn()
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
    unobserve() {} disconnect() {}
  })
  vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return parseFloat(this.style.width) || 1000
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return parseFloat(this.style.height) || 800
  })
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number
    constructor(type: string, options: PointerEventInit) { super(type, options); this.pointerId = options.pointerId ?? 1 }
  })
  SVGElement.prototype.setPointerCapture = vi.fn()
  SVGElement.prototype.releasePointerCapture = vi.fn()
  useGraphDraftStore.getState().installNextDraft(key, structuredClone(context))
  geometry.mockClear(); change.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useGraphDraftStore.getState().clearAllDrafts()
})

function Zoom() {
  const flow = useReactFlow()
  return <button onClick={() => void flow.setViewport({ x: 0, y: 0, zoom: 0.1 })}>Minimum zoom</button>
}
function FixtureCanvas() {
  const [graph, setGraph] = useState(context.draft.graph)
  return <><DraftCanvas draftKey={key} graph={graph} agents={context.agents.map((item) => item.agent)} kind="execution"
    change={change} geometry={(changes: GraphGeometryChange[]) => {
      geometry(changes); setGraph((value) => applyGraphGeometry(value, changes))
    }} pending={vi.fn()} report={vi.fn()} /><Zoom /></>
}
function mount() {
  return render(<GraphPresentationProvider><ReactFlowProvider><FixtureCanvas /></ReactFlowProvider></GraphPresentationProvider>)
}

it('keeps the edge remove button mounted while crossing to its controls', async () => {
  render(<style>{canvasStyles}</style>)
  const view = mount()
  const remove = await screen.findByLabelText(/Remove handoff/)
  const control = remove.closest('foreignObject')!
  const edge = control.parentElement!
  vi.useFakeTimers()
  expect(remove).not.toBeVisible()
  fireEvent.pointerEnter(edge)
  expect(remove).toBeVisible()
  fireEvent.pointerLeave(edge)
  act(() => vi.advanceTimersByTime(100))
  fireEvent.pointerEnter(remove)
  act(() => vi.advanceTimersByTime(200))
  expect(screen.getByRole('button', { name: /Remove handoff/ })).toBe(remove)
  fireEvent.pointerLeave(edge)
  act(() => vi.advanceTimersByTime(160))
  expect(remove).not.toBeVisible()
  expect(view.container.contains(remove)).toBe(true)
  act(() => remove.focus())
  expect(remove).toBeVisible()
  expect(remove).toHaveFocus()
  fireEvent.blur(remove)
  fireEvent.pointerEnter(edge)
  fireEvent.click(remove)
  expect(change).toHaveBeenCalledOnce()
  expect(change.mock.calls[0][0](context.draft.graph).edges).toEqual([])
})

function mouse(target: Element | Window, type: 'mousedown' | 'mousemove' | 'mouseup', clientX: number, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: type === 'mouseup' ? 0 : 1 })
  // Vitest's Window proxy is not accepted by jsdom 30's UIEvent constructor.
  Object.defineProperty(event, 'view', { value: document.defaultView })
  fireEvent(target, event)
}

it.each(['pan', 'wheel zoom'])('preserves the draft viewport after a manual %s and canvas resize', async (gesture) => {
  const layout = installFlowLayout(1000, 800)
  const { container } = mount()
  const viewport = container.querySelector<HTMLElement>('.react-flow__viewport')!
  await waitFor(() => expect(viewport.style.transform).toContain('scale(1)'))
  const initial = viewport.style.transform
  const pane = container.querySelector('.react-flow__pane')!
  if (gesture === 'pan') {
    mouse(pane, 'mousedown', 200, 200)
    mouse(document.defaultView!, 'mousemove', 250, 240)
    mouse(document.defaultView!, 'mouseup', 250, 240)
  } else {
    fireEvent.wheel(pane, { deltaY: -100, clientX: 200, clientY: 200 })
  }
  await waitFor(() => expect(viewport.style.transform).not.toBe(initial))
  const adjusted = viewport.style.transform
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
  act(() => layout.resize(320, 480))
  // Cover the resize debounce and animation frames without advancing wall time.
  await act(async () => { await vi.advanceTimersByTimeAsync(120) })
  expect(viewport.style.transform).toBe(adjusted)
  expect(geometry).not.toHaveBeenCalled()
  expect(change).not.toHaveBeenCalled()
})

it('refits the draft after a stationary canvas click and resize', async () => {
  const layout = installFlowLayout(1000, 800)
  const { container } = mount()
  const viewport = container.querySelector<HTMLElement>('.react-flow__viewport')!
  await waitFor(() => expect(viewport.style.transform).toContain('scale(1)'))
  const initial = viewport.style.transform
  const pane = container.querySelector('.react-flow__pane')!
  mouse(pane, 'mousedown', 200, 200)
  mouse(document.defaultView!, 'mouseup', 200, 200)
  expect(viewport.style.transform).toBe(initial)
  act(() => layout.resize(320, 480))
  await waitFor(() => expect(viewport.style.transform).not.toBe(initial))
  const zoom = Number(/scale\(([-\d.]+)\)/.exec(viewport.style.transform)![1])
  expect(zoom).toBeLessThan(1)
  expect(geometry).not.toHaveBeenCalled()
  expect(change).not.toHaveBeenCalled()
})

function pointer(ring: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', x: number, y: number) {
  const viewport = ring.closest('.react-flow')!.querySelector<HTMLElement>('.react-flow__viewport')!
  const [, tx, ty, zoom] = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(viewport.style.transform)!
  fireEvent[type](ring, { pointerId: 1, button: 0, clientX: Number(tx) + x * Number(zoom), clientY: Number(ty) + y * Number(zoom) })
}

it('resizes from the circular rim at minimum zoom, keeping the center without connecting', async () => {
  const { container } = mount()
  fireEvent.click(screen.getByRole('button', { name: /^Node 0, / }))
  const ring = await screen.findByRole('slider', { name: 'Resize Node 0' })
  fireEvent.click(screen.getByRole('button', { name: 'Minimum zoom' }))
  await waitFor(() => expect(container.querySelector('.react-flow__viewport')?.getAttribute('style')).toContain('scale(0.1)'))
  pointer(ring, 'pointerDown', 156, 78)
  pointer(ring, 'pointerMove', 196, 78)
  expect(geometry).not.toHaveBeenCalled()
  expect(container.querySelector('.react-flow__node[data-id="node-0"]')).toHaveStyle({ width: '236px', height: '236px' })
  pointer(ring, 'pointerUp', 196, 78)
  expect(geometry).toHaveBeenCalledWith([{ id: 'node-0', position: { x: -40, y: -40 }, width: 236, height: 236 }])
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /^Node 1, / }))
  expect(change).not.toHaveBeenCalled()
})

it('resizes from the top rim and clamps the circular diameter to the existing limits', async () => {
  mount()
  const ring = await screen.findByRole('slider', { name: 'Resize Node 0' })
  pointer(ring, 'pointerDown', 78, 0)
  pointer(ring, 'pointerUp', 78, -400)
  expect(geometry).toHaveBeenLastCalledWith([{ id: 'node-0', position: { x: -82, y: -82 }, width: 320, height: 320 }])
  for (let index = 0; index < 9; index++) fireEvent.keyDown(ring, { key: 'ArrowLeft', shiftKey: true })
  expect(ring).toHaveAttribute('aria-valuenow', '120')
  // The Board places nodes itself, so only the size is a saved fact here.
  expect(geometry.mock.lastCall![0][0]).toMatchObject({ id: 'node-0', width: 120, height: 120 })
  expect(change).not.toHaveBeenCalled()
})

it('offers a focusable circular control, keyboard sizing and no edit on stationary or cancelled gestures', async () => {
  const { container } = mount()
  const ring = await screen.findByRole('slider', { name: 'Resize Node 0' })
  expect(ring).toHaveAttribute('tabindex', '0')
  expect(container.querySelector('.react-flow__resize-control')).toBeNull()
  pointer(ring, 'pointerDown', 156, 78)
  pointer(ring, 'pointerUp', 156, 78)
  expect(geometry).not.toHaveBeenCalled()
  pointer(ring, 'pointerDown', 156, 78)
  pointer(ring, 'pointerMove', 194, 78)
  pointer(ring, 'pointerCancel', 194, 78)
  expect(geometry).not.toHaveBeenCalled()
  expect(container.querySelector('.react-flow__node[data-id="node-0"]')).toHaveStyle({ width: '156px', height: '156px' })
  act(() => { ring.focus(); fireEvent.keyDown(ring, { key: 'ArrowRight' }) })
  expect(geometry).toHaveBeenCalledWith([{ id: 'node-0', position: { x: -4, y: -4 }, width: 164, height: 164 }])
  expect(change).not.toHaveBeenCalled()
})
