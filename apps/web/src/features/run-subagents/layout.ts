import type { RunBoardNodeSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { RunSubagent } from '@foreman-code/contracts/subagents'

export const isTerminalSubagent = (status: RunSubagent['status']) => ['completed', 'failed', 'canceled'].includes(status)
export type SubagentLayoutNode = Pick<RunBoardNodeSnapshot, 'id' | 'kind' | 'position' | 'size'>

/** Orb geometry shared with the stylesheet: a small agent circle with its name underneath. */
export const SUBAGENT_ORB = { size: 40, labelWidth: 96, gap: 40, ring: 72 } as const

/**
 * Screen angles in degrees (y grows downward), 40 degrees apart so labels never
 * touch. They avoid the agent card's action buttons (upper right) and its edge
 * handles (left and right); straight down clears the entry badge at this
 * distance. An eighth child starts a wider ring.
 */
const SLOTS = [130, 50, 90, 170, 10, 210, 250]

export type SubagentOrb = { subagent: RunSubagent; x: number; y: number; from: { x: number; y: number }; parentId: string }

/**
 * Native children orbit the agent that spawned them, like small copies of it.
 * (x, y) is the orb's center; `from` is where its link starts: the parent
 * card's rim, or the center of the child that spawned it.
 */
export function layoutSubagents(nodes: readonly SubagentLayoutNode[], children: readonly RunSubagent[]): SubagentOrb[] {
  const result: SubagentOrb[] = []
  const ordered = [...children].sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt) || a.id.localeCompare(b.id))
  for (const node of nodes) {
    if (node.kind === 'job') continue
    const attached = ordered.filter((child) => child.parentNodeId === node.id)
    const tree: { subagent: RunSubagent; parent: string | null }[] = []
    const visited = new Set<string>()
    const walk = (parentId: string | null) => {
      for (const child of attached.filter((item) => item.parentSubagentId === parentId)) {
        if (visited.has(child.id)) continue
        visited.add(child.id)
        tree.push({ subagent: child, parent: parentId })
        walk(child.id)
      }
    }
    walk(null)
    const radius = Math.min(node.size.width, node.size.height) / 2
    const cx = node.position.x + node.size.width / 2, cy = node.position.y + node.size.height / 2
    const centers = new Map<string, { x: number; y: number }>()
    tree.forEach(({ subagent, parent }, index) => {
      const angle = SLOTS[index % SLOTS.length]! * Math.PI / 180
      const distance = radius + SUBAGENT_ORB.gap + SUBAGENT_ORB.size / 2 + Math.floor(index / SLOTS.length) * SUBAGENT_ORB.ring
      const center = { x: cx + distance * Math.cos(angle), y: cy + distance * Math.sin(angle) }
      centers.set(subagent.id, center)
      const from = parent ? centers.get(parent)! : { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
      result.push({ subagent, ...center, from, parentId: parent ?? node.id })
    })
  }
  return result
}
