import { act, fireEvent, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResponsiveGraphViewport, RESPONSIVE_FIT_OPTIONS } from './useResponsiveGraphViewport'

class FakeObserver {
  static all: FakeObserver[] = []
  disconnect = vi.fn()
  observe = vi.fn()
  constructor(private cb: ResizeObserverCallback) { FakeObserver.all.push(this) }
  size(width: number, height: number) {
    this.cb([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

function Harness({ flow, enabled = true }: { flow: unknown; enabled?: boolean }) {
  const { containerRef, onInit, onMove, onManualMove } = useResponsiveGraphViewport({ enabled })
  useEffect(() => { onInit(flow as never) }, [flow, onInit])
  return <div ref={containerRef} data-testid="canvas"
    onWheel={(event) => onMove(event.nativeEvent, { x: 10, y: 20, zoom: 0.5 })}>
    <button onClick={onManualMove}>Zoom in</button>
    <button onClick={() => onMove(null, { x: 10, y: 20, zoom: 0.5 })}>Programmatic move</button>
  </div>
}
const settle = () => act(() => { vi.advanceTimersByTime(100) })

describe('responsive graph viewport', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeObserver.all = []; vi.stubGlobal('ResizeObserver', FakeObserver) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const make = () => ({ fitView: vi.fn(async () => true), getNodes: vi.fn(() => [{ id: 'a', position: { x: 1, y: 2 } }]) })

  it('refits to the measured size on resize without touching node geometry', () => {
    const flow = make()
    const nodes = flow.getNodes()
    render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(1100, 800)); settle()
    expect(flow.fitView).not.toHaveBeenCalled()
    act(() => ro.size(390, 800)); act(() => ro.size(320, 800)); settle()
    expect(flow.fitView).toHaveBeenCalledTimes(1)
    expect(flow.fitView).toHaveBeenCalledWith({ ...RESPONSIVE_FIT_OPTIONS, duration: 0 })
    expect(RESPONSIVE_FIT_OPTIONS.minZoom).toBeLessThanOrEqual(0.15)
    expect(nodes[0]!.position).toEqual({ x: 1, y: 2 })
  })

  it('ignores hidden, unchanged and rerender-only measurements', () => {
    const flow = make()
    const view = render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(800, 600)); act(() => ro.size(0, 0)); act(() => ro.size(800, 600)); settle()
    view.rerender(<Harness flow={flow} />); settle()
    expect(flow.fitView).not.toHaveBeenCalled()
  })

  it('keeps a user-panned or zoomed view across height and width changes', () => {
    const flow = make()
    const view = render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(800, 600))
    fireEvent.wheel(view.getByTestId('canvas'))
    act(() => ro.size(800, 500)); settle()
    expect(flow.fitView).not.toHaveBeenCalled()
    act(() => ro.size(390, 500)); settle()
    expect(flow.fitView).not.toHaveBeenCalled()
  })

  it('preserves a control-button zoom even if a resize fit is already pending', () => {
    const flow = make()
    const view = render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(800, 600))
    act(() => ro.size(390, 600))
    fireEvent.click(view.getByRole('button', { name: 'Zoom in' }))
    settle()
    expect(flow.fitView).not.toHaveBeenCalled()
  })

  it('refits after ordinary canvas clicks and programmatic viewport moves', () => {
    const flow = make()
    const view = render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(800, 600))
    fireEvent.pointerDown(view.getByTestId('canvas'))
    fireEvent.click(view.getByRole('button', { name: 'Programmatic move' }))
    act(() => ro.size(800, 500))
    settle()
    expect(flow.fitView).toHaveBeenCalledTimes(1)
  })

  it('cancels pending fits and disconnects on unmount', () => {
    const flow = make()
    const view = render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(800, 600)); act(() => ro.size(390, 600))
    view.unmount(); settle()
    expect(ro.disconnect).toHaveBeenCalled()
    expect(flow.fitView).not.toHaveBeenCalled()
  })

  it('does not observe while disabled (hidden selected Run)', () => {
    render(<Harness flow={make()} enabled={false} />)
    expect(FakeObserver.all).toHaveLength(0)
  })
})
