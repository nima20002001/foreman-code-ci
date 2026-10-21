import { vi } from 'vitest'

/** jsdom supplies no layout/ResizeObserver. Only browser geometry is shimmed:
 * React Flow, the shared node/edge renderers, Router, Query and HTTP stay real.
 * This is NOT a substitute for the 320px browser verification in the handoff.
 */
export function installFlowLayout(width = 320, height = 480) {
  const observers = new Set<Observer>()
  const dimensions = (element: HTMLElement) => {
    if (element.classList.contains('react-flow__handle')) return { width: 8, height: 8 }
    const px = (value: string) => /^\d+(?:\.\d+)?px$/.test(value) ? parseFloat(value) : undefined
    return { width: px(element.style.width) ?? width, height: px(element.style.height) ?? height }
  }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return dimensions(this).width
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return dimensions(this).height
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const size = dimensions(this)
    const translate = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(this.style.transform)
    let x = Number(translate?.[1] ?? 0), y = Number(translate?.[2] ?? 0)
    if (this.classList.contains('react-flow__handle')) {
      const parent = this.closest<HTMLElement>('.react-flow__node')!
      const bounds = parent.getBoundingClientRect()
      const side = this.getAttribute('data-handlepos')
      x = bounds.x + (side === 'left' ? 0 : side === 'right' ? bounds.width : bounds.width / 2) - size.width / 2
      y = bounds.y + (side === 'top' ? 0 : side === 'bottom' ? bounds.height : bounds.height / 2) - size.height / 2
    }
    return new DOMRect(x, y, size.width, size.height)
  })
  class Observer implements ResizeObserver {
    private targets = new Set<Element>()
    private callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      observers.add(this)
    }
    notify() {
      const entries = [...this.targets].map((target) => {
        const contentRect = target.getBoundingClientRect()
        const size = [{ inlineSize: contentRect.width, blockSize: contentRect.height }]
        return { target, contentRect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size }
      })
      if (entries.length) this.callback(entries, this)
    }
    observe(target: Element) {
      this.targets.add(target)
      queueMicrotask(() => {
        if (!this.targets.has(target)) return
        this.notify()
      })
    }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() {
      this.targets.clear()
      observers.delete(this)
    }
  }
  vi.stubGlobal('ResizeObserver', Observer)
  // The synthetic rectangles above use unscaled coordinates consistently.
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
  return {
    resize(nextWidth: number, nextHeight: number) {
      width = nextWidth
      height = nextHeight
      for (const observer of observers) observer.notify()
    },
  }
}
