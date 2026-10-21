import type { Node, NodeChange } from '@xyflow/react'
import type { GraphNode } from './types'
import { GRAPH_NODE_MIN_WIDTH, GRAPH_NODE_MAX_WIDTH, GRAPH_NODE_MIN_HEIGHT, GRAPH_NODE_MAX_HEIGHT } from './mapper'
import { retainArray, sameFields } from './graphReferences'

export type GraphGeometryChange = {
  id: string
  position?: { x: number; y: number }
  width?: number
  height?: number
}

function size(width: number, height: number) {
  return {
    width: Math.max(GRAPH_NODE_MIN_WIDTH, Math.min(GRAPH_NODE_MAX_WIDTH, width)),
    height: Math.max(GRAPH_NODE_MIN_HEIGHT, Math.min(GRAPH_NODE_MAX_HEIGHT, height)),
  }
}

/** Apply geometry only. Never replace metadata/edges or resurrect a remotely removed node. */
export function applyGraphGeometry<T extends { nodes: readonly { id: string; position?: { x: number; y: number }; width?: number; height?: number }[] }>(workflow: T, changes: readonly GraphGeometryChange[]): T {
  const byId = new Map(changes.map((change) => [change.id, change]))
  let changed = false
  const nodes = workflow.nodes.map((node) => {
    const change = byId.get(node.id)
    if (!change) return node
    const next = {
      ...node,
      ...(change.position ? { position: { ...change.position, manual: true } } : {}),
      ...(change.width !== undefined ? { width: change.width } : {}),
      ...(change.height !== undefined ? { height: change.height } : {}),
    }
    if (node.position && next.position && sameFields(node.position, next.position)) next.position = node.position
    if (sameFields(node, next)) return node
    changed = true
    return next
  })
  return changed ? { ...workflow, nodes } : workflow
}

/**
 * Renderer-local buffer. Pointer events never enter the draft or presentation store.
 * Its pending records are patches, not a second workflow definition.
 */
export function createGraphGeometryAdapter<T extends Node = GraphNode>(initial: T[]) {
  let base = initial
  let nodes = initial
  const pending = new Map<string, GraphGeometryChange>()
  let resizing = false
  const draggingIds = new Set<string>()

  function replaceNode(id: string, update: (node: T) => T) {
    const next = nodes.map((node) => node.id === id ? update(node) : node)
    nodes = retainArray(nodes, next)
  }

  function remember(change: GraphGeometryChange) {
    const next = { ...pending.get(change.id), ...change }
    const original = base.find((node) => node.id === change.id)
    if (original) {
      if (next.position && sameFields(original.position, next.position)) delete next.position
      if (next.width !== undefined || next.height !== undefined) {
        if ((next.width ?? original.width) === original.width && (next.height ?? original.height) === original.height) {
          delete next.width; delete next.height
        } else {
          // Any authored resize pins both dimensions, even when only one edge moved.
          // A later role refresh must not replace the untouched dimension with its default.
          next.width ??= original.width; next.height ??= original.height
        }
      }
    }
    if (next.position || next.width !== undefined || next.height !== undefined) pending.set(change.id, next)
    else pending.delete(change.id)
  }

  function reconcile(nextBase: T[], selectedIds: ReadonlySet<string>) {
    base = nextBase
    const ids = new Set(base.map((node) => node.id))
    for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id)
    for (const id of draggingIds) if (!ids.has(id)) draggingIds.delete(id)
    const previous = new Map(nodes.map((node) => [node.id, node]))
    nodes = retainArray(nodes, base.map((node) => {
      const before = previous.get(node.id)
      const change = pending.get(node.id)
      const candidate: T = {
        ...node,
        ...(before?.measured ? { measured: before.measured } : {}),
        ...(change?.position ? { position: change.position } : {}),
        ...(change?.width !== undefined || change?.height !== undefined ? {
          width: change.width ?? node.width, height: change.height ?? node.height,
          style: { ...node.style, width: change.width ?? node.width, height: change.height ?? node.height } } : {}),
        selected: selectedIds.has(node.id),
      }
      if (before && sameFields(before, candidate)) return before
      return sameFields(node, candidate) ? node : candidate
    }))
    return nodes
  }

  function update(changes: readonly NodeChange<T>[]) {
    let finished = false
    for (const change of changes) {
      if (change.type !== 'position' && change.type !== 'dimensions') continue
      if (change.type === 'position' && change.dragging === false) draggingIds.delete(change.id)
      const node = nodes.find((item) => item.id === change.id)
      if (!node) continue
      if (change.type === 'position') {
        if (change.dragging === true) draggingIds.add(change.id)
        if (change.position && Number.isFinite(change.position.x) && Number.isFinite(change.position.y)) {
          const position = sameFields(node.position, change.position) ? node.position : change.position
          if (position !== node.position) remember({ id: node.id, position })
          replaceNode(node.id, (current) => position === current.position ? current : { ...current, position })
        }
        // React Flow can send the terminal dragging:false without repeating position.
        if (change.dragging === false || (change.position && change.dragging === undefined && !resizing)) finished = true
      } else {
        const dimensions = change.dimensions
        if (dimensions && Number.isFinite(dimensions.width) && Number.isFinite(dimensions.height)) {
          const measured = node.measured && sameFields(node.measured, dimensions) ? node.measured : dimensions
          replaceNode(node.id, (current) => current.measured === measured ? current : { ...current, measured })
          // Initial ResizeObserver measurements are not authored edits.
          if (resizing || change.resizing !== undefined) {
            const nextSize = size(dimensions.width, dimensions.height)
            if (node.width !== nextSize.width || node.height !== nextSize.height) remember({ id: node.id, ...nextSize })
            replaceNode(node.id, (current) => ({ ...current, ...nextSize,
              style: { ...current.style, ...nextSize } }))
          }
        }
        if (change.resizing === true) resizing = true
        // NodeResizer.onResizeEnd owns the final atomic size+position commit.
      }
    }
    return { nodes, finished: finished && !resizing && draggingIds.size === 0, pending: pending.size > 0 }
  }

  function finishResize(id: string, width: number, height: number, position?: { x: number; y: number }) {
    const node = nodes.find((item) => item.id === id)
    if (node && Number.isFinite(width) && Number.isFinite(height)) {
      const nextSize = size(width, height)
      remember({ id, ...nextSize, ...(position && Number.isFinite(position.x) && Number.isFinite(position.y)
        ? { position } : {}) })
      replaceNode(id, (current) => ({ ...current, ...nextSize,
        ...(position && Number.isFinite(position.x) && Number.isFinite(position.y) ? { position } : {}), style: { ...current.style, ...nextSize } }))
    }
    resizing = false
    return nodes
  }

  return {
    getNodes: () => nodes,
    hasPending: () => pending.size > 0,
    beginResize: () => { resizing = true },
    reconcile,
    update,
    finishResize,
    flush: (): GraphGeometryChange[] => {
      const changes = [...pending.values()]
      pending.clear()
      draggingIds.clear()
      resizing = false
      // Until the parent's committed projection arrives, keep the last pointer position.
      base = nodes
      return changes
    },
    cancel: () => {
      const selected = new Set(nodes.filter((node) => node.selected).map((node) => node.id))
      pending.clear()
      draggingIds.clear()
      resizing = false
      nodes = retainArray(base, reconcile(base, selected))
      return nodes
    },
  }
}
