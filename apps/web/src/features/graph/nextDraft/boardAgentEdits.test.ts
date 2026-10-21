import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { GraphDraftOperationV3Schema } from '@foreman-code/contracts/wave25'
import { fixture } from './core.cases'
import { draftOperations } from './model'
import { newNextDraft, editNextDraft, undoNextDraft, redoNextDraft, nextDraftDirty } from './state'
import { acknowledgeAgentEdits, changeDraftAgent, configureAgentOperations, hasAgentEdits, referencedAgentEdits } from './agentEdits'

function context() {
  const result = fixture()
  result.agents[0]!.agent.harnessConfiguration = DEFAULT_HARNESS_DEFAULTS.codex
  return result
}
describe('board Agent edits use the existing typed serial writer', () => {
  it('redos graph and Agent edits together and clears redo after a new edit', () => {
    const c = context(), base = newNextDraft(c, 'instance')
    const changed = changeDraftAgent(base, { ...c.agents[0]!.agent, name: 'Renamed' }, base.graph)
    const undone = undoNextDraft(changed)
    const redone = redoNextDraft(undone)
    expect(redone.agentEdits).toEqual(changed.agentEdits)
    expect(redone.graph).toEqual(changed.graph)
    expect(redone.context).toBe(changed.context)
    expect(editNextDraft(undone, (graph) => ({ ...graph, name: 'Other change' })).future).toEqual([])
    expect(changeDraftAgent(undone, { ...c.agents[0]!.agent, name: 'Different' }, base.graph).future).toEqual([])
  })
  it('stages settings locally without changing the server context or its revision', () => {
    const c = context(), before = structuredClone(c), agent = { ...c.agents[0]!.agent, name: 'Renamed' }
    const edit = changeDraftAgent(newNextDraft(c, 'instance'), agent, c.draft.graph)
    expect(c).toEqual(before); expect(edit.context.draft.revision).toBe(7)
    expect(hasAgentEdits(edit)).toBe(true); expect(nextDraftDirty(edit)).toBe(true)
    expect(configureAgentOperations(c, edit.graph, edit.agentEdits!)).toEqual([
      { type: 'agent.rename', agentId: agent.id, expectedAgentRevision: 3, name: 'Renamed' },
    ])
  })
  it.each([{ busy: true }, { pending: { kind: 'save' as const, commandId: 'pending', workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft', expectedRevision: 7, executionSemanticsVersion: 3 as const } }])('does not replace an in-flight/uncertain command %#', (state) => {
    const c = context(), edit = { ...newNextDraft(c, 'instance'), ...state }
    expect(() => changeDraftAgent(edit, { ...c.agents[0]!.agent, name: 'New' }, c.draft.graph)).toThrow()
  })
  it('supports Undo across geometry and Agent edits without rewinding the revision', () => {
    const c = context(), base = newNextDraft(c, 'instance')
    const changed = changeDraftAgent(base, { ...c.agents[0]!.agent, name: 'New' }, base.graph)
    const moved = editNextDraft(changed, (graph) => ({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, position: { x: 44, y: 55 } })) }))
    expect(undoNextDraft(moved).agentEdits).toEqual(changed.agentEdits)
    expect(hasAgentEdits(undoNextDraft(undoNextDraft(moved)))).toBe(false)
    expect(undoNextDraft(moved).context.draft.revision).toBe(7)
  })
  it('does not invent source configuration pins for a newly created Agent', () => {
    const c = context(), agent = { ...c.agents[0]!.agent, id: 'new-agent', configurationVersionId: undefined }
    const graph = { ...c.draft.graph, nodes: [...c.draft.graph.nodes, { id: 'new-node', agentId: agent.id, name: agent.name }] }
    const operations = draftOperations(c, graph, { [agent.id]: agent })
    expect(operations.some((op) => op.type === 'agent.add')).toBe(true)
    expect(operations.some((op) => op.type === 'agent.attach')).toBe(false)
    for (const operation of operations) expect(GraphDraftOperationV3Schema.safeParse(operation).success).toBe(true)
    expect(c.draft.sourceAgentPins).toBeUndefined()
  })
  it('keeps exact source pins for attaching an existing Agent', () => {
    const c = context(); const source = { ...c.agents[0]!, agent: { ...c.agents[0]!.agent, id: 'catalog-agent' } }
    c.agents.push(source)
    const graph = { ...c.draft.graph, nodes: [...c.draft.graph.nodes, { id: 'attached', agentId: source.agent.id }] }
    expect(draftOperations(c, graph)).toContainEqual({ type: 'agent.attach', agentId: source.agent.id, nodeId: 'attached',
      expectedAgentRevision: 3, expectedConfigurationVersionId: source.agent.configurationVersionId, name: undefined })
  })
  it('acknowledges only the submitted settings and preserves newer local changes', () => {
    const c = context(), sent = { ...c.agents[0]!.agent, name: 'Submitted' }
    const newer = { ...sent, name: 'Newer' }
    c.agents[0]!.agent = { ...sent, configurationVersionId: 'new-pin' }
    expect(acknowledgeAgentEdits({ [sent.id]: sent }, { [sent.id]: sent }, c)).toEqual({})
    expect(acknowledgeAgentEdits({ [sent.id]: newer }, { [sent.id]: sent }, c)?.[sent.id]).toMatchObject({ name: 'Newer', configurationVersionId: 'new-pin' })
  })
  it('can return to the accepted settings without a stuck dirty flag', () => {
    const c = context(), base = newNextDraft(c, 'instance'), agent = c.agents[0]!.agent
    const changed = changeDraftAgent(base, { ...agent, name: 'Changed' }, base.graph)
    expect(hasAgentEdits(changeDraftAgent(changed, agent, base.graph))).toBe(false)
  })
  it('does not transmit Agent edits after their node was removed', () => {
    const c = context()
    expect(referencedAgentEdits({ ...c.draft.graph, nodes: [] }, { 'agent-0': c.agents[0]!.agent })).toEqual({})
  })
})
