export type RunsWindowRect = { left: number; top: number; width: number; height: number }
export type RunsWindowBounds = { left: number; top: number; width: number; height: number }
export const RUNS_RESIZE_EDGES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
export type RunsResizeEdge = typeof RUNS_RESIZE_EDGES[number]

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

export function clampRunsWindow(rect: RunsWindowRect, bounds: RunsWindowBounds): RunsWindowRect {
  const width = clamp(rect.width, Math.min(296, bounds.width), bounds.width)
  const height = clamp(rect.height, Math.min(180, bounds.height), bounds.height)
  return { width, height, left: clamp(rect.left, bounds.left, bounds.left + bounds.width - width),
    top: clamp(rect.top, bounds.top, bounds.top + bounds.height - height) }
}

/** Keep the opposite edge fixed, including minimum size and viewport limits. */
export function resizeRunsWindow(rect: RunsWindowRect, edge: RunsResizeEdge, dx: number, dy: number, bounds: RunsWindowBounds): RunsWindowRect {
  const start = clampRunsWindow(rect, bounds)
  const minWidth = Math.min(296, bounds.width), minHeight = Math.min(180, bounds.height)
  let left = start.left, top = start.top, right = left + start.width, bottom = top + start.height
  if (edge.includes('w')) left = clamp(left + dx, bounds.left, right - minWidth)
  if (edge.includes('e')) right = clamp(right + dx, left + minWidth, bounds.left + bounds.width)
  if (edge.includes('n')) top = clamp(top + dy, bounds.top, bottom - minHeight)
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + minHeight, bounds.top + bounds.height)
  return { left, top, width: right - left, height: bottom - top }
}
