
/**
 * The executable/presentation boundary used by authoring and save admission.
 * Node display names, board geometry and server version stamps are omitted
 * from execution comparisons. New fields remain meaningful until explicitly
 * classified. Viewport, selection and panel collapse are not workflow fields.
 * This is content comparison, not workflow validation or execution authority.
 */
export function sameWorkflowValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => sameWorkflowValue(item, right[index]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a).filter((key) => a[key] !== undefined)
  return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length
    && keys.every((key) => sameWorkflowValue(a[key], b[key]))
}

type PresentedNode = { id: string; name?: unknown; label?: unknown; position?: unknown; width?: unknown; height?: unknown }
const geometryFields = ['position', 'width', 'height'] as const

export function executableNodeContent<T extends PresentedNode>(node: T): Omit<T, 'position' | 'width' | 'height'> {
  const { position, width, height, ...content } = node
  void position; void width; void height
  return content
}

type PresentedWorkflow = {
  nodes: ReadonlyArray<PresentedNode>
  name?: unknown
  description?: unknown
  version?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

function authoredWorkflowContent<T extends PresentedWorkflow>(graph: T) {
  const { version, createdAt, updatedAt, ...content } = graph
  void version; void createdAt; void updatedAt
  return { ...content, nodes: graph.nodes.map(executableNodeContent) }
}

function executableWorkflowContent<T extends PresentedWorkflow>(graph: T) {
  const authored = authoredWorkflowContent(graph)
  const nodes = authored.nodes.map((node) => {
    const execution = { ...node }
    delete execution.name
    delete execution.label
    return execution
  })
  return { ...authored, nodes }
}

export function sameAuthoredWorkflow(left: PresentedWorkflow, right: PresentedWorkflow): boolean {
  return sameWorkflowValue(authoredWorkflowContent(left), authoredWorkflowContent(right))
}

/** Acknowledgements may differ in geometry, not scope, version stamps or other
 * metadata. Dirtiness deliberately has a different server-stamp rule. */
export function sameWorkflowExceptGeometry(left: PresentedWorkflow, right: PresentedWorkflow): boolean {
  return sameWorkflowValue({ ...left, nodes: left.nodes.map(executableNodeContent) },
    { ...right, nodes: right.nodes.map(executableNodeContent) })
}

export function sameExecutableWorkflow(left: PresentedWorkflow, right: PresentedWorkflow): boolean {
  return sameWorkflowValue(executableWorkflowContent(left), executableWorkflowContent(right))
}

/** Hydrate mutable names and geometry after the executable definition is checked. */
export function preserveWorkflowPresentation<T extends PresentedWorkflow>(definition: T, presentation: T): T {
  const current = new Map(presentation.nodes.map((node) => [node.id, node]))
  const nodes = definition.nodes.map((node) => {
    const displayed = current.get(node.id)
    if (!displayed) return node
    const result = { ...preserveNodeGeometry(node, displayed) }
    for (const field of ['name', 'label'] as const) {
      if (Object.hasOwn(displayed, field)) result[field] = displayed[field]
      else delete result[field]
    }
    return result
  })
  return { ...definition, nodes }
}

export function preserveNodeGeometry<T extends PresentedNode>(definition: T, presentation: PresentedNode): T {
  if (geometryFields.every((field) => sameWorkflowValue(definition[field], presentation[field]))) return definition
  const result = { ...definition }
  for (const field of geometryFields) {
    if (Object.hasOwn(presentation, field)) result[field] = presentation[field]
    else delete result[field]
  }
  return result
}

/** Restore/acknowledge meaning without erasing independently edited geometry.
 * Only retained nodes inherit layout; removed nodes are not resurrected and
 * newly introduced nodes keep their supplied geometry. No input is mutated.
 */
export function preserveWorkflowGeometry<T extends PresentedWorkflow>(definition: T, presentation: T): T {
  const current = new Map(presentation.nodes.map((node) => [node.id, node]))
  const nodes = definition.nodes.map((node) => {
    const displayed = current.get(node.id)
    return displayed ? preserveNodeGeometry(node, displayed) : node
  })
  return nodes.every((node, index) => node === definition.nodes[index]) ? definition : { ...definition, nodes }
}
