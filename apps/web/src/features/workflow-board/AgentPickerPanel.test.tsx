import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentPickerPanel } from './AgentPickerPanel'

afterEach(() => vi.unstubAllGlobals())

it('moves by pointer or keyboard within board bounds and closes from its X', () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const close = vi.fn()
  const { container } = render(<div><AgentPickerPanel close={close}><button>Worker</button></AgentPickerPanel></div>)
  const panel = screen.getByRole('complementary', { name: 'Add node' })
  Object.defineProperties(container.firstElementChild!, { clientWidth: { value: 800 }, clientHeight: { value: 600 } })
  Object.defineProperties(panel, {
    offsetWidth: { value: 340 }, offsetHeight: { value: 130 },
    offsetLeft: { get: () => panel.style.left ? parseFloat(panel.style.left) : 400 },
    offsetTop: { get: () => panel.style.top ? parseFloat(panel.style.top) : 72 },
  })
  const handle = screen.getByRole('button', { name: 'Add node' })
  Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() })
  fireEvent.pointerDown(handle, { button: 0, clientX: 400, clientY: 72 })
  fireEvent.pointerMove(handle, { clientX: 100, clientY: 172 })
  fireEvent.pointerUp(handle)
  expect(panel).toHaveStyle({ left: '100px', top: '172px' })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(panel).toHaveStyle({ left: '120px' })
  fireEvent.pointerDown(handle, { button: 0, clientX: 120, clientY: 172 })
  fireEvent.pointerMove(handle, { clientX: 9999, clientY: 9999 })
  fireEvent.pointerUp(handle)
  expect(panel).toHaveStyle({ left: '460px', top: '470px' })
  fireEvent.click(screen.getByRole('button', { name: 'Worker' }))
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close node picker' }))
  expect(close).toHaveBeenCalledTimes(1)
})
