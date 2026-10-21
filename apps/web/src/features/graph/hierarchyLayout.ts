export type LayoutNode = { id: string; width: number; height: number }
export type LayoutEdge = { source: string; target: string }
export type LayoutPoint = { x: number; y: number }

/** Free space between neighbours in a layer, and between layers, on top of the node sizes. */
export const LAYOUT_GAP_X = 56
export const LAYOUT_GAP_Y = 104
const SWEEPS = 4

/**
 * Lays a workflow out as a hierarchy: the entry node on top, each node one layer below its
 * deepest parent, siblings side by side in the same layer and every layer centred.
 * Back edges (cycles, repeat carries) are ignored for layering, so they never break it.
 * Nodes the entry cannot reach start a layer of their own at the top. Returns top-left corners.
 */
export function layoutHierarchy(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], entryId?: string): Map<string, LayoutPoint> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.id, []]))
  const hasParent = new Set<string>()
  for (const edge of edges) {
    const key = `${edge.source}\u0000${edge.target}`
    if (!byId.has(edge.source) || !byId.has(edge.target) || edge.source === edge.target || seen.has(key)) continue
    seen.add(key)
    outgoing.get(edge.source)!.push(edge.target)
    hasParent.add(edge.target)
  }

  // Depth-first walk from the entry, then from every other root: an edge into a node still being
  // walked closes a cycle. Edges into the entry never pull it down from the top.
  const state = new Map<string, 1 | 2>()
  const forward = new Map<string, string[]>(nodes.map((node) => [node.id, []]))
  const walk = (id: string) => {
    state.set(id, 1)
    for (const next of outgoing.get(id)!) {
      if (next === entryId || state.get(next) === 1) continue
      forward.get(id)!.push(next)
      if (!state.has(next)) walk(next)
    }
    state.set(id, 2)
  }
  const roots = [...(entryId && byId.has(entryId) ? [entryId] : []),
    ...nodes.filter((node) => !hasParent.has(node.id)).map((node) => node.id), ...nodes.map((node) => node.id)]
  for (const id of roots) if (!state.has(id)) walk(id)

  // Longest path from the roots, in topological order of the cycle-free edges.
  const parents = new Map<string, string[]>(nodes.map((node) => [node.id, []]))
  for (const [source, targets] of forward) for (const target of targets) parents.get(target)!.push(source)
  const layerOf = new Map<string, number>()
  const depth = (id: string): number => {
    const known = layerOf.get(id)
    if (known !== undefined) return known
    const value = parents.get(id)!.reduce((deepest, parent) => Math.max(deepest, depth(parent) + 1), 0)
    layerOf.set(id, value)
    return value
  }
  for (const node of nodes) depth(node.id)

  const rows: LayoutNode[][] = []
  for (const node of nodes) (rows[layerOf.get(node.id)!] ??= []).push(node)
  const centers = new Map<string, number>()
  const centre = () => {
    for (const row of rows) {
      let x = -(row.reduce((sum, node) => sum + node.width, 0) + LAYOUT_GAP_X * (row.length - 1)) / 2
      for (const node of row) { centers.set(node.id, x + node.width / 2); x += node.width + LAYOUT_GAP_X }
    }
  }
  centre()

  // Order each layer by the mean position of its neighbours in the layer before (then after) it.
  const children = forward
  const order = (row: LayoutNode[], neighbours: Map<string, string[]>) => {
    const key = new Map(row.map((node) => {
      const near = neighbours.get(node.id)!
      return [node.id, near.length ? near.reduce((sum, id) => sum + centers.get(id)!, 0) / near.length : centers.get(node.id)!]
    }))
    row.sort((a, b) => key.get(a.id)! - key.get(b.id)!)
  }
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    if (sweep % 2 === 0) for (let index = 1; index < rows.length; index += 1) { order(rows[index]!, parents); centre() }
    else for (let index = rows.length - 2; index >= 0; index -= 1) { order(rows[index]!, children); centre() }
  }

  const positions = new Map<string, LayoutPoint>()
  let y = 0
  for (const row of rows) {
    for (const node of row) positions.set(node.id, { x: centers.get(node.id)! - node.width / 2, y })
    y += Math.max(...row.map((node) => node.height)) + LAYOUT_GAP_Y
  }
  const left = Math.min(...[...positions.values()].map((point) => point.x))
  for (const point of positions.values()) point.x -= left
  return positions
}
