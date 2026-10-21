import { DomainError } from '../errors.js'

export interface ExecutionTopology {
  entryNodeId: string
  order: string[]
  excluded: string[]
  incoming: Map<string, import('@foreman-code/contracts/wave25').WorkflowRelationship[]>
  outgoing: Map<string, import('@foreman-code/contracts/wave25').WorkflowRelationship[]>
  sinks: string[]
  /** LangGraph supersteps, deliberately independent of the native execution budget. */
  recursionLimit: number
}

/** Current static DAG compiler. Call only with a directly validated V3 version
 * or a validated block's induced subgraph. It never parses or retags another
 * execution semantics. Approval relationships are not execution dependencies. */
export function compileExecutionTopology(version: {
  entryNodeId: string
  definition: { entryNodeId?: string | null; nodes: readonly { id: string }[]; edges: readonly import('@foreman-code/contracts/wave25').WorkflowRelationship[] }
}): ExecutionTopology {
  const nodes = new Set(version.definition.nodes.map((node) => node.id))
  if (!nodes.size || nodes.size !== version.definition.nodes.length || !nodes.has(version.entryNodeId)
    || version.definition.entryNodeId !== version.entryNodeId) {
    throw new DomainError('WORKFLOW_ENTRY_INVALID', 'The immutable version must pin an existing, authored entry.', 409)
  }
  const incoming: ExecutionTopology['incoming'] = new Map([...nodes].map((id) => [id, []]))
  const outgoing: ExecutionTopology['outgoing'] = new Map([...nodes].map((id) => [id, []]))
  const relationshipIds = new Set<string>()
  for (const edge of version.definition.edges) {
    if (relationshipIds.has(edge.id) || !nodes.has(edge.source) || !nodes.has(edge.target) || edge.source === edge.target) {
      throw new DomainError('WORKFLOW_EDGE_INVALID', `Relationship '${edge.id}' has invalid identity or endpoints.`, 409)
    }
    relationshipIds.add(edge.id)
    if (edge.kind === 'approval') continue
    if (edge.kind !== 'execution') throw new DomainError('WORKFLOW_EDGE_INVALID', 'A relationship requires an explicit kind.', 409)
    incoming.get(edge.target)!.push(edge)
    outgoing.get(edge.source)!.push(edge)
  }
  if (incoming.get(version.entryNodeId)!.length) {
    throw new DomainError('WORKFLOW_ENTRY_DEPENDENCY', 'The entry cannot have an incoming execution dependency.', 409)
  }
  // Deterministic input order is by relationship identity, never layout or array position.
  for (const edges of [...incoming.values(), ...outgoing.values()]) edges.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const degrees = new Map([...incoming].map(([id, edges]) => [id, edges.length]))
  const queue = [...nodes].filter((id) => degrees.get(id) === 0).sort()
  const depth = new Map([...nodes].map((id) => [id, 1]))
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!
    for (const edge of outgoing.get(id)!) {
      depth.set(edge.target, Math.max(depth.get(edge.target)!, depth.get(id)! + 1))
      const remaining = degrees.get(edge.target)! - 1
      degrees.set(edge.target, remaining)
      if (remaining === 0) queue.push(edge.target)
    }
  }
  if (queue.length !== nodes.size) throw new DomainError('WORKFLOW_REPEAT_UNSUPPORTED', 'Authored execution relationships must be acyclic; only explicit finite block boundaries may repeat.', 409)
  const reachable = new Set<string>()
  const visit = [version.entryNodeId]
  for (let head = 0; head < visit.length; head++) {
    const id = visit[head]!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const edge of outgoing.get(id)!) visit.push(edge.target)
  }
  for (const id of reachable) {
    if (incoming.get(id)!.some((edge) => !reachable.has(edge.source))) {
      throw new DomainError('WORKFLOW_EXCLUDED_DEPENDENCY', 'An excluded component cannot supply a selected-component dependency.', 409)
    }
  }
  const order = queue.filter((id) => reachable.has(id))
  return {
    entryNodeId: version.entryNodeId, order, excluded: [...nodes].filter((id) => !reachable.has(id)).sort(),
    incoming, outgoing,
    sinks: order.filter((id) => outgoing.get(id)!.length === 0),
    recursionLimit: Math.max(...order.map((id) => depth.get(id)!)) + 2,
  }
}

export type ExecutionAdmissionDecision =
  | { kind: 'resolved'; resolution: import('@foreman-code/contracts/wave25').NodeResolution }
  | { kind: 'waiting' | 'skipped' | 'excluded' }
  | { kind: 'run'; selected: import('@foreman-code/contracts/wave25').WorkflowRelationship[] }

/** A missing fact is unresolved, not an unselected edge. Every incoming edge must settle first. */
export function decideExecutionAdmission(
  topology: ExecutionTopology, nodeId: string,
  resolutions: ReadonlyMap<string, import('@foreman-code/contracts/wave25').NodeResolution>,
): ExecutionAdmissionDecision {
  if (!topology.incoming.has(nodeId)) throw new DomainError('WORKFLOW_NODE_NOT_FOUND', `Node '${nodeId}' was not found.`, 409)
  const existing = resolutions.get(nodeId)
  if (existing) {
    if (existing.workflowNodeId !== nodeId) throw new DomainError('WORKFLOW_RESOLUTION_INVALID', 'A resolution cannot be replayed under another node.', 409)
    return { kind: 'resolved', resolution: existing }
  }
  if (topology.excluded.includes(nodeId)) return { kind: 'excluded' }
  if (nodeId === topology.entryNodeId) return { kind: 'run', selected: [] }
  const selected: import('@foreman-code/contracts/wave25').WorkflowRelationship[] = []
  let unresolved = false
  for (const edge of topology.incoming.get(nodeId)!) {
    const source = resolutions.get(edge.source)
    if (!source) { unresolved = true; continue }
    if (source.workflowNodeId !== edge.source) throw new DomainError('WORKFLOW_RESOLUTION_INVALID', 'A predecessor resolution belongs to another node.', 409)
    const yes = source.selectedRelationshipIds.includes(edge.id)
    const no = source.unselectedRelationshipIds.includes(edge.id)
    if (yes === no || (yes && (source.resolution !== 'succeeded' || !source.execution || !source.acceptedResultDigest))) {
      throw new DomainError('WORKFLOW_RESOLUTION_INVALID', `Relationship '${edge.id}' has no unambiguous accepted resolution.`, 409)
    }
    if (yes) selected.push(edge)
  }
  if (unresolved) return { kind: 'waiting' }
  return selected.length ? { kind: 'run', selected } : { kind: 'skipped' }
}

/** Includes a selected branch end even when its node is not a static sink. */
export function selectedTerminalResolutions(
  resolutions: readonly import('@foreman-code/contracts/wave25').NodeResolution[],
): import('@foreman-code/contracts/wave25').NodeResolution[] {
  return resolutions.filter((resolution) => resolution.resolution === 'succeeded'
    && resolution.selectedRelationshipIds.length === 0).sort((a, b) => a.workflowNodeId < b.workflowNodeId ? -1 : a.workflowNodeId > b.workflowNodeId ? 1 : 0)
}
