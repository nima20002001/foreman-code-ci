import { describe, expect, it } from 'vitest'
import { currentWorkflowFixture } from '../../shared/mocks/currentWorkflow'
import { workflowToGraph } from './mapper'
import { applyGraphGeometry, createGraphGeometryAdapter } from './geometry'
import { putRelationship, removeRelationship } from './nextDraft/model'
import { fixture } from './nextDraft/core.cases'
import { editNextDraft, newNextDraft, nextDraftDirty } from './nextDraft/state'

describe('current V3 geometry and explicit typed relationships', () => {
  it('projects larger Orchestrators without authoring default geometry or executable edits', () => {
    const context = fixture(), graph = context.draft.graph, before = structuredClone(graph)
    const agents = context.agents.map((item, index) => ({ ...item.agent, productRole: index ? 'coder' as const : 'orchestrator' as const }))
    const rendered = workflowToGraph({ workflow: graph, agents })
    expect(rendered.nodes.map(({ width, height }) => [width, height])).toEqual([[188, 188], [156, 156]])
    const adapter = createGraphGeometryAdapter(rendered.nodes)
    adapter.update(rendered.nodes.map((node) => ({ type: 'dimensions', id: node.id,
      dimensions: { width: node.width!, height: node.height! } })))
    expect(adapter.flush()).toEqual([])
    expect(graph).toEqual(before)
    expect(newNextDraft(context, 'role-defaults').history).toEqual([])
    expect(nextDraftDirty(newNextDraft(context, 'role-defaults'))).toBe(false)
  })

  it('keeps authored dimensions through settings and role refreshes and reloads', () => {
    const context = fixture(), graph = context.draft.graph
    const rendered = workflowToGraph({ workflow: graph, agents: context.agents.map((item) => item.agent) })
    const adapter = createGraphGeometryAdapter(rendered.nodes), first = rendered.nodes[0]!
    adapter.beginResize(); adapter.finishResize(first.id, 360, first.height!)
    const resized = applyGraphGeometry(graph, adapter.flush())
    for (const productRole of ['coder', 'orchestrator'] as const) {
      const agents = context.agents.map((item) => ({ ...item.agent, productRole, name: 'Updated settings' }))
      const node = workflowToGraph({ workflow: structuredClone(resized), agents }).nodes[0]!
      expect(node).toMatchObject({ width: 360, height: 156, style: { width: 360, height: 156 } })
    }
    expect(nextDraftDirty(editNextDraft(newNextDraft(context, 'resized'), () => resized))).toBe(false)
  })
  it.each([false, true])('preserves exact executable meaning and optional-repeat absence (drag=%s)', (drag) => {
    const { version } = currentWorkflowFixture('geometry'), graph = version.definition, before = structuredClone(graph)
    const rendered = workflowToGraph({ workflow: graph, agents: [] })
    const result = applyGraphGeometry(graph, drag ? [{ id: graph.nodes[0]!.id, position: { x: 150, y: -250 } }] : [])
    expect(result.edges).toBe(graph.edges); expect(result.executionSemanticsVersion).toBe(3)
    expect(result).not.toHaveProperty('repeat'); expect(graph).toEqual(before)
    expect(rendered.edges[0]?.data?.explanation).toEqual(expect.any(String))
  })
  it('cannot change relationship meaning under an existing ID and does not resurrect removals', () => {
    const graph = currentWorkflowFixture('relationship').version.definition, edge = graph.edges[0]!
    expect(() => putRelationship(graph, { ...edge, kind: 'approval' })).toThrow(/identity/)
    const removed = removeRelationship(graph, edge.id)
    expect(applyGraphGeometry(removed, [{ id: graph.nodes[0]!.id, position: { x: 9, y: 8 } }]).edges).toEqual([])
  })
  it('keeps React Flow measurement out of persisted geometry and flushes a drag once', () => {
    const graph = currentWorkflowFixture('buffer').version.definition
    const rendered = workflowToGraph({ workflow: graph, agents: [] }), adapter = createGraphGeometryAdapter(rendered.nodes)
    adapter.update([{ type: 'dimensions', id: graph.nodes[0]!.id, dimensions: { width: 200, height: 100 } }])
    expect(adapter.flush()).toEqual([])
    adapter.update([{ type: 'position', id: graph.nodes[0]!.id, position: { x: 121, y: 97 }, dragging: true }])
    adapter.update([{ type: 'position', id: graph.nodes[0]!.id, dragging: false }])
    expect(adapter.flush()).toEqual([{ id: graph.nodes[0]!.id, position: { x: 121, y: 97 } }])
    expect(adapter.flush()).toEqual([])
  })
})
