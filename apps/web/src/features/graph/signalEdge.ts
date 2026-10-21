import { useInternalNode, type InternalNode, type Node } from '@xyflow/react'
import type { Agent } from '@foreman-code/contracts'
import type { IconName } from '../../shared/ui/nocturne'

/** Default worker diameter; authored dimensions and role defaults determine each actual rim. */
export const AGENT_NODE_SIZE = 212
const RIM_GAP = 7

type Point = { x: number; y: number }
/** box: a rectangular node (the CI server), whose rim is its border rather than an inscribed ellipse. */
type RimSize = { width: number; height: number; box?: boolean }
/** task: a handoff; return: a repeat carry; approval: a request for review; grant: its answer; error: a failed receiver. */
export type EdgeSignal = 'task' | 'return' | 'approval' | 'grant' | 'error'
export type FloatingCurve = { path: string; mid: Point & { angle: number } }

function dimensions(node: InternalNode<Node>): RimSize {
  return { width: node.measured.width ?? node.width ?? AGENT_NODE_SIZE,
    height: node.measured.height ?? node.height ?? AGENT_NODE_SIZE, ...(node.data.rim === 'box' ? { box: true } : {}) }
}
function center(node: InternalNode<Node>): Point {
  const { width, height } = dimensions(node)
  return { x: node.internals.positionAbsolute.x + width / 2, y: node.internals.positionAbsolute.y + height / 2 }
}
const unit = (x: number, y: number) => { const length = Math.hypot(x, y) || 1; return { x: x / length, y: y / length } }

/** A gently bent curve that leaves and enters each agent anywhere on its rim. */
export function floatingCurve(source: Point, target: Point, bend: number, radius = AGENT_NODE_SIZE / 2 + RIM_GAP,
  sourceSize?: RimSize, targetSize?: RimSize): FloatingCurve {
  const dx = target.x - source.x, dy = target.y - source.y, length = Math.hypot(dx, dy) || 1
  const control = { x: (source.x + target.x) / 2 - dy / length * bend, y: (source.y + target.y) / 2 + dx / length * bend }
  const leave = unit(control.x - source.x, control.y - source.y), enter = unit(target.x - control.x, target.y - control.y)
  const rim = (direction: Point, size?: RimSize) => size?.box
    ? Math.min(size.width / 2 / Math.abs(direction.x || 1e-9), size.height / 2 / Math.abs(direction.y || 1e-9)) + RIM_GAP
    : size ? 1 / Math.hypot(direction.x / (size.width / 2), direction.y / (size.height / 2)) + RIM_GAP : radius
  const sourceRadius = rim(leave, sourceSize), targetRadius = rim(enter, targetSize)
  const start = { x: source.x + leave.x * sourceRadius, y: source.y + leave.y * sourceRadius }
  const end = { x: target.x - enter.x * targetRadius, y: target.y - enter.y * targetRadius }
  const mid = { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 }
  const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI
  const round = (value: number) => Math.round(value * 10) / 10
  return { path: `M ${round(start.x)},${round(start.y)} Q ${round(control.x)},${round(control.y)} ${round(end.x)},${round(end.y)}`, mid: { ...mid, angle } }
}

/** Parallel connections between the same pair fan out instead of overlapping. The first one adds no bend of its own. */
export function edgeBend(index: number, forward: boolean) {
  const step = Math.ceil(index / 2) * (index % 2 ? 1 : -1)
  return step * 44 * (forward ? 1 : -1)
}

const ALIGNED = 8
const LEAN = 0.3
const LEAN_MAX = 90
const BACK_LEAN = 110
/**
 * The bend a line needs from where its two ends sit: none when they are aligned, otherwise a curve
 * that leans to the side the target is on. A line that runs back up the hierarchy leans further, so a
 * return never lies on top of the forward line between the same two nodes (which leans to the other side).
 * The sign follows `floatingCurve`: the control point moves along (-dy, dx) by `bend`.
 */
export function lineBend(source: Point, target: Point): number {
  const dx = target.x - source.x, dy = target.y - source.y, length = Math.hypot(dx, dy)
  const vertical = Math.abs(dy) >= Math.abs(dx)
  const across = vertical ? dx : dy
  const back = vertical && dy < -ALIGNED
  if (Math.abs(across) <= ALIGNED && !back) return 0
  const side = across === 0 ? 1 : Math.sign(across)
  const size = back ? Math.max(BACK_LEAN, Math.abs(across) * LEAN) : Math.min(LEAN_MAX, Math.abs(across) * LEAN)
  // The perpendicular is (-dy, dx) / length: its x part decides a vertical line, its y part a horizontal one.
  const normal = vertical ? -dy / length : dx / length
  return size * side * Math.sign(normal)
}

export function useFloatingCurve(source: string, target: string, bend: number): FloatingCurve | undefined {
  const from = useInternalNode(source), to = useInternalNode(target)
  if (!from || !to) return undefined
  const [start, end] = [center(from), center(to)]
  return floatingCurve(start, end, lineBend(start, end) + bend, undefined, dimensions(from), dimensions(to))
}

const cap = (value: string) => value ? value[0]!.toUpperCase() + value.slice(1) : value

/** Words shown on an agent node; never inferred from a label. */
export type AgentFactsSource = Partial<Pick<Agent, 'harnessConfiguration' | 'harness' | 'productRole' | 'effort' | 'model' | 'harnessSummary'>>
export function agentNodeFacts(agent: AgentFactsSource, role?: string): {
  harness?: string; harnessLabel: string; model?: string; icon: IconName; roleLabel: string; meta: { label: string; value: string }[]
} {
  const configuration = agent.harnessConfiguration
  const harness = configuration?.harness ?? agent.harness
  const productRole = role ?? agent.productRole
  const roleLabel = productRole === 'orchestrator' ? 'Orchestrator' : productRole === 'coder' ? 'Worker'
    : productRole ? cap(productRole) : 'Agent'
  const effort = configuration ? configuration.harness === 'codex' ? configuration.reasoningEffort : undefined : harness === 'claude' ? undefined : agent.effort
  const meta = [
    ...(effort ? [{ label: 'Effort', value: cap(String(effort)) }] : []),
    { label: 'Role', value: roleLabel },
  ]
  const lower = `${productRole ?? ''}`.toLowerCase()
  return {
    harness, harnessLabel: harness === 'codex' ? 'Codex' : harness === 'opencode' ? 'Retired harness (OpenCode): read-only' : harness === 'claude' ? 'Claude' : agent.harnessSummary?.label ?? 'Harness not set',
    model: configuration?.model ?? agent.model, roleLabel, meta,
    icon: lower.includes('review') ? 'eye' : lower.includes('orchestrat') ? 'workflow' : lower.includes('cod') ? 'code' : 'bot',
  }
}

const sandboxLabels = { 'read-only': 'Read only', 'workspace-write': 'Can edit the workspace', 'danger-full-access': 'Full access' } as const

/** Effective configuration rows for the Info panel. */
export function agentSettingRows(agent: Agent): { label: string; value: string; mono?: boolean }[] {
  const facts = agentNodeFacts(agent), configuration = agent.harnessConfiguration
  return [
    { label: 'Harness', value: facts.harnessLabel },
    { label: 'Model', value: facts.model ?? 'Not set' },
    ...facts.meta.filter((item) => item.label !== 'Role'),
    ...(configuration && configuration.harness !== 'opencode' ? [{ label: 'Sandbox', value: sandboxLabels[configuration.sandbox] }] : []),
  ]
}

type Relationship = { id: string; kind: 'execution' | 'approval'; source: string; target: string }
type LineMember = { id: string; kind: Relationship['kind']; flipped: boolean }
/** One drawn line per agent pair: an approval beside a handoff shares the handoff's line.
 * `flipped` marks a member that runs against the line's drawn direction. */
export function relationshipLines<T extends Relationship>(relationships: readonly T[]) {
  const lines = relationships.filter((item) => item.kind === 'execution').map((item) => ({ ...item, members: [{ id: item.id, kind: item.kind, flipped: false }] as LineMember[] }))
  for (const approval of relationships.filter((item) => item.kind === 'approval')) {
    const host = lines.find((line) => line.kind === 'execution' && !line.members.some((member) => member.kind === 'approval')
      && (line.source === approval.source && line.target === approval.target || line.source === approval.target && line.target === approval.source))
    if (host) host.members.push({ id: approval.id, kind: 'approval', flipped: host.source !== approval.source })
    else lines.push({ ...approval, members: [{ id: approval.id, kind: 'approval', flipped: false }] })
  }
  const alias = new Map(lines.flatMap((line) => line.members.map((member) => [member.id, { lineId: line.id, flipped: member.flipped }] as const)))
  return { lines, alias }
}
