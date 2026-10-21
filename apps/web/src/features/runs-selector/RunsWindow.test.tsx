import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunsWindow } from './RunsWindow'
import { useRunsSelectorUi } from './uiStore'
import { clampRunsWindow, resizeRunsWindow, RUNS_RESIZE_EDGES } from './windowGeometry'

const bounds = { left: 12, top: 12, width: 776, height: 576 }
const initial = { left: 100, top: 100, width: 400, height: 300 }
beforeEach(() => {
  useRunsSelectorUi.setState({ openId: null, geometry: { scope: 'workflow-one', rect: initial } })
  vi.stubGlobal('PointerEvent', MouseEvent)
})
afterEach(() => vi.unstubAllGlobals())

describe('Runs window geometry', () => {
  it('clamps positions and size to a narrow visible viewport', () => {
    expect(clampRunsWindow({ left: 900, top: 900, width: 440, height: 420 }, { left: 12, top: 12, width: 296, height: 150 }))
      .toEqual({ left: 12, top: 12, width: 296, height: 150 })
  })
  it.each(RUNS_RESIZE_EDGES)('resizes from %s while preserving the opposite edges', (edge) => {
    const result = resizeRunsWindow(initial, edge, 20, 30, bounds)
    expect(result.left).toBe(edge.includes('w') ? 120 : 100)
    expect(result.top).toBe(edge.includes('n') ? 130 : 100)
    expect(result.width).toBe(edge.includes('w') ? 380 : edge.includes('e') ? 420 : 400)
    expect(result.height).toBe(edge.includes('n') ? 270 : edge.includes('s') ? 330 : 300)
  })
  it('limits resize at the viewport and minimum size without moving the opposite edge', () => {
    expect(resizeRunsWindow(initial, 'nw', 9999, 9999, bounds)).toEqual({ left: 204, top: 220, width: 296, height: 180 })
    expect(resizeRunsWindow(initial, 'se', 9999, 9999, bounds)).toEqual({ left: 100, top: 100, width: 688, height: 488 })
  })
})

function mount(scope = 'workflow-one') {
  const close = vi.fn(), anchor = createRef<HTMLButtonElement>()
  const rendered = render(<><button ref={anchor}>Runs</button><RunsWindow id="runs-window" scope={scope} anchor={anchor} close={close}>
    <button>Saved run</button>
  </RunsWindow></>)
  return { ...rendered, close, anchor }
}

it('moves and resizes by pointer, cancels gestures, and never makes Close a drag handle', () => {
  const { close } = mount()
  const panel = screen.getByRole('dialog', { name: 'Runs' })
  expect(screen.getByRole('heading', { name: 'Runs' })).toBeInTheDocument()
  const move = screen.getByRole('button', { name: 'Move Runs window' })
  Object.defineProperty(move, 'setPointerCapture', { value: vi.fn() })
  fireEvent.pointerDown(move, { button: 0, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(move, { clientX: 160, clientY: 140 })
  fireEvent.pointerUp(move)
  expect(panel).toHaveStyle({ left: '160px', top: '140px' })
  fireEvent.pointerMove(move, { clientX: 300, clientY: 300 })
  expect(panel).toHaveStyle({ left: '160px', top: '140px' })
  const resize = screen.getByRole('button', { name: 'Resize Runs window' })
  Object.defineProperty(resize, 'setPointerCapture', { value: vi.fn() })
  fireEvent.pointerDown(resize, { button: 0, clientX: 560, clientY: 440 })
  fireEvent.pointerMove(resize, { clientX: 620, clientY: 480 })
  fireEvent.pointerCancel(resize)
  expect(panel).toHaveStyle({ width: '460px', height: '340px' })
  fireEvent.pointerMove(resize, { clientX: 700, clientY: 500 })
  expect(panel).toHaveStyle({ width: '460px', height: '340px' })
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Close Runs' }), { button: 0, clientX: 700, clientY: 500 })
  fireEvent.pointerMove(move, { clientX: 800, clientY: 600 })
  expect(panel).toHaveStyle({ left: '160px', top: '140px' })
  fireEvent.click(screen.getByRole('button', { name: 'Saved run' }))
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close Runs' }))
  expect(close).toHaveBeenCalledTimes(1)
})

it('provides keyboard move/resize, keeps geometry on reopen and separates workflow scope', () => {
  const first = mount()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Move Runs window' }), { key: 'ArrowRight' })
  fireEvent.keyDown(screen.getByRole('button', { name: 'Resize Runs window' }), { key: 'ArrowDown', shiftKey: true })
  expect(screen.getByRole('dialog', { name: 'Runs' })).toHaveStyle({ left: '120px', height: '340px' })
  fireEvent.keyDown(screen.getByRole('button', { name: 'Resize Runs window' }), { key: 'Escape' })
  expect(first.close).toHaveBeenCalledTimes(1)
  first.unmount()
  const second = mount()
  expect(screen.getByRole('dialog', { name: 'Runs' })).toHaveStyle({ left: '120px', height: '340px' })
  second.unmount()
  mount('workflow-two')
  expect(screen.getByRole('dialog', { name: 'Runs' })).toHaveStyle({ left: '12px', width: '560px', height: '420px' })
})

it('reclamps an open window after viewport resize and uses the visual viewport', () => {
  mount()
  vi.stubGlobal('visualViewport', { offsetLeft: 20, offsetTop: 30, width: 320, height: 240,
    addEventListener: vi.fn(), removeEventListener: vi.fn() })
  fireEvent(window, new Event('resize'))
  expect(screen.getByRole('dialog', { name: 'Runs' })).toHaveStyle({ left: '32px', top: '42px', width: '296px', height: '216px' })
})
