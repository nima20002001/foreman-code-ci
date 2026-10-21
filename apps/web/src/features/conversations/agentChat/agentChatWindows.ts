import { createContext, useContext } from 'react'
import { create } from 'zustand'
import { raiseFloating, releaseFloating } from '../../../shared/ui/floatingStack'

/** Position and size of a floating Agent chat window, in pixels inside the Board. */
export type ChatWindowFrame = { x: number; y: number; width: number; height: number }
export type ChatWindowBounds = { width: number; height: number }
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const CHAT_WINDOW_MIN = { width: 300, height: 320 }
const DEFAULT_SIZE = { width: 400, height: 560 }
const TOP_INSET = 72
const CASCADE = 28

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

/** A rectangle in Board pixels, used for the Agent node a window should not cover. */
export type ChatWindowAnchor = { x: number; y: number; width: number; height: number }

/** The Board's toolbar (Run controls) sits along the top edge; windows never cover it. A Board too short to
 * leave a usable window below the toolbar reserves nothing. */
const topLimit = (bounds: ChatWindowBounds) => bounds.height >= TOP_INSET + CHAT_WINDOW_MIN.height ? TOP_INSET : 0

/** Keeps a frame inside the Board, below the toolbar. A Board that has not been measured (0x0) clamps nothing. */
export function clampFrame(frame: ChatWindowFrame, bounds: ChatWindowBounds): ChatWindowFrame {
  const top = topLimit(bounds), available = bounds.height - top
  const width = bounds.width > 0 ? clamp(frame.width, Math.min(CHAT_WINDOW_MIN.width, bounds.width), bounds.width) : frame.width
  const height = bounds.height > 0 ? clamp(frame.height, Math.min(CHAT_WINDOW_MIN.height, available), available) : frame.height
  return {
    width, height,
    x: bounds.width > 0 ? clamp(frame.x, 0, bounds.width - width) : Math.max(0, frame.x),
    y: bounds.height > 0 ? clamp(frame.y, top, bounds.height - height) : Math.max(0, frame.y),
  }
}

const GAP = 16
const overlaps = (a: ChatWindowFrame, b: ChatWindowAnchor) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** New windows open on the right, each one cascaded below and left of the previous. When that would cover the
 * selected Agent node, the window opens beside it instead (right, left, below, above). */
export function defaultFrame(bounds: ChatWindowBounds, index: number, avoid?: ChatWindowAnchor): ChatWindowFrame {
  const step = (index % 6) * CASCADE
  const cascade = clampFrame({ ...DEFAULT_SIZE, x: bounds.width - DEFAULT_SIZE.width - 24 - step, y: TOP_INSET + step }, bounds)
  if (!avoid || !overlaps(cascade, avoid)) return cascade
  const { width, height } = cascade
  const candidates = [
    { x: avoid.x + avoid.width + GAP, y: avoid.y }, { x: avoid.x - width - GAP, y: avoid.y },
    { x: avoid.x, y: avoid.y + avoid.height + GAP }, { x: avoid.x, y: avoid.y - height - GAP },
  ].map((position) => clampFrame({ width, height, ...position }, bounds))
  return candidates.find((candidate) => !overlaps(candidate, avoid)) ?? cascade
}

/** Moves only the dragged edges. A boundary or minimum size stops that edge and never moves the opposite one. */
export function resizeFrame(start: ChatWindowFrame, edge: ResizeEdge, dx: number, dy: number, bounds: ChatWindowBounds): ChatWindowFrame {
  const top = topLimit(bounds)
  const minWidth = bounds.width > 0 ? Math.min(CHAT_WINDOW_MIN.width, bounds.width) : CHAT_WINDOW_MIN.width
  const minHeight = bounds.height > 0 ? Math.min(CHAT_WINDOW_MIN.height, bounds.height - top) : CHAT_WINDOW_MIN.height
  let left = start.x, right = start.x + start.width, upper = start.y, lower = start.y + start.height
  if (edge.includes('e')) right = clamp(right + dx, left + minWidth, bounds.width > 0 ? bounds.width : Infinity)
  if (edge.includes('w')) left = clamp(left + dx, 0, right - minWidth)
  if (edge.includes('s')) lower = clamp(lower + dy, upper + minHeight, bounds.height > 0 ? bounds.height : Infinity)
  if (edge.includes('n')) upper = clamp(upper + dy, top, lower - minHeight)
  return { x: left, y: upper, width: right - left, height: lower - upper }
}

type ChatWindowsState = {
  /** Open Agent node ids per Board view, back to front. */
  open: Record<string, readonly string[]>
  /** Last position and size per Agent node, so a closed or re-selected window comes back where it was. */
  frames: Record<string, ChatWindowFrame>
  /** Bumped whenever a window is opened or re-selected, so it takes focus. */
  focus: Record<string, number>
  openWindow(scope: string, nodeId: string): void
  raise(scope: string, nodeId: string): void
  closeWindow(scope: string, nodeId: string): void
  setFrame(scope: string, nodeId: string, frame: ChatWindowFrame): void
}

export const chatWindowKey = (scope: string, nodeId: string) => `${scope}|${nodeId}`
const toFront = (ids: readonly string[] = [], nodeId: string) => ids.at(-1) === nodeId ? ids : [...ids.filter((id) => id !== nodeId), nodeId]

/** Local interaction state only: not shareable through the URL and not server state. */
export const useChatWindowsStore = create<ChatWindowsState>((set) => ({
  open: {}, frames: {}, focus: {},
  openWindow: (scope, nodeId) => { raiseFloating(chatWindowKey(scope, nodeId)); set((state) => ({
    open: { ...state.open, [scope]: toFront(state.open[scope], nodeId) },
    focus: { ...state.focus, [chatWindowKey(scope, nodeId)]: (state.focus[chatWindowKey(scope, nodeId)] ?? 0) + 1 },
  })) },
  raise: (scope, nodeId) => { raiseFloating(chatWindowKey(scope, nodeId)); set((state) => {
    const ids = toFront(state.open[scope], nodeId)
    return ids === state.open[scope] ? state : { open: { ...state.open, [scope]: ids } }
  }) },
  closeWindow: (scope, nodeId) => { releaseFloating(chatWindowKey(scope, nodeId)); set((state) => ({ open: { ...state.open, [scope]: (state.open[scope] ?? []).filter((id) => id !== nodeId) } })) },
  setFrame: (scope, nodeId, frame) => set((state) => ({ frames: { ...state.frames, [chatWindowKey(scope, nodeId)]: frame } })),
}))

/** Lets the chat inside a window close that window instead of whatever popover state its builder knows. */
export const WindowCloseContext = createContext<(() => void) | undefined>(undefined)
export const useAgentChatWindowClose = () => useContext(WindowCloseContext)
