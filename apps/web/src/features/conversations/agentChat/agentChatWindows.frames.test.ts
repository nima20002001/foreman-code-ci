import { describe, expect, it } from 'vitest'
import { CHAT_WINDOW_MIN, clampFrame, defaultFrame, resizeFrame, type ChatWindowFrame } from './agentChatWindows'

const board = { width: 1000, height: 700 }
const overlap = (a: ChatWindowFrame, b: ChatWindowFrame) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

describe('chat window frames keep clear of the Run controls', () => {
  it.each([700, 560, 480, 400])('never lets a window reach the toolbar strip on a %ipx tall Board', (height) => {
    const frame = clampFrame({ x: 100, y: 0, width: 400, height: 560 }, { width: 1000, height })
    expect(frame.y).toBeGreaterThanOrEqual(72)
    expect(frame.y + frame.height).toBeLessThanOrEqual(height)
    expect(frame.height).toBeGreaterThanOrEqual(Math.min(CHAT_WINDOW_MIN.height, height - 72))
  })

  it('opens below the toolbar when the Board is shorter than the default window', () => {
    expect(defaultFrame({ width: 1000, height: 560 }, 0).y).toBeGreaterThanOrEqual(72)
  })

  it('stops dragging the top edge at the toolbar strip', () => {
    const frame = resizeFrame({ x: 100, y: 200, width: 400, height: 400 }, 'n', 0, -500, board)
    expect(frame.y).toBe(72)
    expect(frame.y + frame.height).toBe(600)
  })
})

describe('resizing against a boundary keeps the opposite edge fixed', () => {
  const start: ChatWindowFrame = { x: 600, y: 100, width: 400, height: 400 }
  it('east at the right Board edge', () => {
    expect(resizeFrame(start, 'e', 50, 0, board)).toEqual(start)
  })
  it('west at the left Board edge', () => {
    const frame = resizeFrame({ ...start, x: 40 }, 'w', -100, 0, board)
    expect(frame.x).toBe(0)
    expect(frame.x + frame.width).toBe(440)
  })
  it('south at the bottom Board edge', () => {
    const frame = resizeFrame({ ...start, y: 250 }, 's', 0, 100, board)
    expect(frame.y).toBe(250)
    expect(frame.y + frame.height).toBe(700)
  })
  it('a corner clamps each dragged edge on its own', () => {
    const frame = resizeFrame({ x: 620, y: 300, width: 300, height: 340 }, 'se', 200, 200, board)
    expect([frame.x, frame.y]).toEqual([620, 300])
    expect([frame.x + frame.width, frame.y + frame.height]).toEqual([1000, 700])
  })
  it('minimum size stops the dragged edge without moving the opposite one', () => {
    const west = resizeFrame(start, 'w', 500, 0, board)
    expect([west.x + west.width, west.width]).toEqual([1000, CHAT_WINDOW_MIN.width])
    const north = resizeFrame(start, 'n', 0, 500, board)
    expect([north.y + north.height, north.height]).toEqual([500, CHAT_WINDOW_MIN.height])
  })
})

describe('initial placement avoids the selected Agent', () => {
  it('keeps the usual place when the Agent is elsewhere', () => {
    expect(defaultFrame(board, 0, { x: 20, y: 300, width: 200, height: 200 })).toEqual(defaultFrame(board, 0))
  })
  it.each([
    ['the right side', { x: 620, y: 150, width: 200, height: 200 }],
    ['the middle', { x: 450, y: 200, width: 212, height: 212 }],
    ['the whole top right', { x: 560, y: 72, width: 440, height: 600 }],
  ])('moves beside an Agent on %s', (_, node) => {
    const frame = defaultFrame(board, 0, node)
    expect(overlap(frame, node)).toBe(false)
    expect(clampFrame(frame, board)).toEqual(frame)
  })
})
