import { useCallback, useEffect, useRef } from 'react'
import type { Edge, Node, OnMove, ReactFlowInstance } from '@xyflow/react'

/** Fit options shared by both canvases. The low zoom floor keeps saved nodes reachable on phone widths. */
export const RESPONSIVE_MIN_ZOOM = 0.1
export const RESPONSIVE_FIT_OPTIONS = { padding: 0.2, minZoom: RESPONSIVE_MIN_ZOOM, maxZoom: 1 }

/**
 * Refits the viewport when the measured canvas size changes (e.g. desktop -> phone). Only the
 * viewport transform changes: node positions, draft/geometry/save callbacks and access are untouched.
 * Ordinary data rerenders never refit, and a user who has panned/zoomed keeps their view across resizes.
 */
export function useResponsiveGraphViewport<N extends Node = Node, E extends Edge = Edge>(
  { enabled = true, delay = 80, fitViewOptions = RESPONSIVE_FIT_OPTIONS }: {
    enabled?: boolean; delay?: number; fitViewOptions?: typeof RESPONSIVE_FIT_OPTIONS
  } = {},
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const instance = useRef<ReactFlowInstance<N, E> | null>(null)
  const moved = useRef(false)
  const onInit = useCallback((next: ReactFlowInstance<N, E>) => { instance.current = next }, [])
  const onManualMove = useCallback(() => { moved.current = true }, [])
  const onMove = useCallback<OnMove>((event) => {
    if (event) onManualMove()
  }, [onManualMove])

  useEffect(() => {
    const element = containerRef.current
    if (!enabled) {
      instance.current = null
      return
    }
    if (!element || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    let last: { w: number; h: number } | undefined
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      if (!box) return
      const w = Math.round(box.width)
      const h = Math.round(box.height)
      if (w <= 0 || h <= 0) return // hidden: nothing measurable to fit
      const prev = last
      last = { w, h }
      if (!prev || moved.current || (prev.w === w && prev.h === h)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const flow = instance.current
        if (moved.current || !flow || flow.getNodes().length === 0) return
        void flow.fitView({ ...fitViewOptions, duration: 0 })
      }, delay)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [enabled, delay, fitViewOptions])

  return { containerRef, onInit, onMove, onManualMove }
}
