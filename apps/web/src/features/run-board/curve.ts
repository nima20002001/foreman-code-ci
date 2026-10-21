import type { Position } from '@xyflow/react'
import type { FloatingCurve } from '../graph/signalEdge'

type Point = { x: number; y: number }
const direction: Record<Position, Point> = {
  top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 },
}

/** Feed the shared SignalEdgeShape real handle coordinates, not today's fixed card radius.
 * Separate parallel relationships; the chevron follows the cubic's midpoint tangent.
 */
export function savedEdgeCurve({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, lane, loop }: {
  sourceX: number; sourceY: number; targetX: number; targetY: number
  sourcePosition: Position; targetPosition: Position; lane: number; loop: boolean
}): FloatingCurve {
  const from = direction[sourcePosition], to = direction[targetPosition]
  const dx = targetX - sourceX, dy = targetY - sourceY, distance = Math.hypot(dx, dy)
  const reach = loop ? 100 + Math.abs(lane) * 36 : Math.max(40, Math.min(250, distance / 3))
  const offset = lane * 44
  const normal = distance ? { x: -dy / distance, y: dx / distance } : { x: -from.y, y: from.x }
  const first = { x: sourceX + from.x * reach + normal.x * offset, y: sourceY + from.y * reach + normal.y * offset }
  const second = { x: targetX + to.x * reach + normal.x * offset, y: targetY + to.y * reach + normal.y * offset }
  if (loop) {
    // Also produces a visible loop when both ends name the very same handle.
    first.x += normal.x * reach; first.y += normal.y * reach
    second.x -= normal.x * reach; second.y -= normal.y * reach
  }
  const mid = {
    x: (sourceX + 3 * first.x + 3 * second.x + targetX) / 8,
    y: (sourceY + 3 * first.y + 3 * second.y + targetY) / 8,
    angle: Math.atan2(-sourceY - first.y + second.y + targetY, -sourceX - first.x + second.x + targetX) * 180 / Math.PI,
  }
  return { path: `M ${sourceX},${sourceY} C ${first.x},${first.y} ${second.x},${second.y} ${targetX},${targetY}`, mid }
}
