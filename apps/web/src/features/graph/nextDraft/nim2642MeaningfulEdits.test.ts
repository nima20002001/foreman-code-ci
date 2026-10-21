import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { describe, expect, it } from 'vitest'
import { fixture } from './core.cases'
import { discardMeaningfulChanges, draftOperations, hasLocalChanges, mergeAcknowledgement } from './model'
import { changeDraftAgent } from './agentEdits'
import { newNextDraft, nextDraftDirty } from './state'

const moved = () => {
  const context = fixture(), graph = structuredClone(context.draft.graph)
  nativeNode(graph.nodes[0]!).position = { x: 700, y: -100 }
  return { context, graph }
}

describe('NIM-2642 typed authoring seams', () => {
  it('does not emit executable operations or dirty a published draft for movement', () => {
    const { context, graph } = moved()
    expect(draftOperations(context, graph)).toEqual([])
    expect(hasLocalChanges(context, graph)).toBe(false)
    expect(nextDraftDirty({ ...newNextDraft(context, 'test'), graph })).toBe(false)
  })
  it('keeps mixed prompt replacements meaningful without serializing the independent drag', () => {
    const { context, graph } = moved()
    nativeNode(graph.nodes[0]!).initialPrompt = 'Exact staged prompt'
    const operations = draftOperations(context, graph)
    expect(operations).toEqual([{ type: 'node.replace_v3', node: { ...nativeNode(graph.nodes[0]!), position: nativeNode(context.draft.graph.nodes[0]!).position } }])
    expect(nativeNode(graph.nodes[0]!).position).toEqual({ x: 700, y: -100 })
  })
  it('uses the existing narrow choice operation when choice and layout change together', () => {
    const { context, graph } = moved()
    nativeNode(graph.nodes[0]!).choice = { outcomes: [{ outcome: 'done', target: { kind: 'branch_end' } }] }
    expect(draftOperations(context, graph)).toEqual([{ type: 'node.set_choice', nodeId: nativeNode(graph.nodes[0]!).id, choice: nativeNode(graph.nodes[0]!).choice }])
  })
  it('discards meaning without Stop or a layout reset', () => {
    const { context, graph } = moved()
    nativeNode(graph.nodes[0]!).initialPrompt = 'Discard this only'
    const restored = discardMeaningfulChanges(context, graph)
    expect(nativeNode(restored.nodes[0]!).initialPrompt).toBe(nativeNode(context.draft.graph.nodes[0]!).initialPrompt)
    expect(nativeNode(restored.nodes[0]!).position).toEqual(nativeNode(graph.nodes[0]!).position)
    expect(hasLocalChanges(context, restored)).toBe(false)
  })
  it('preserves positions on acknowledgements with and without newer semantic typing', () => {
    const { context, graph } = moved(), saved = structuredClone(context.draft.graph)
    saved.version = 2
    expect(mergeAcknowledgement(graph, graph, saved).nodes[0]!.position).toEqual(nativeNode(graph.nodes[0]!).position)
    const newer = structuredClone(graph); nativeNode(newer.nodes[0]!).initialPrompt = 'Newer text'
    const accepted = mergeAcknowledgement(newer, graph, saved)
    expect(nativeNode(accepted.nodes[0]!).initialPrompt).toBe('Newer text')
    expect(nativeNode(accepted.nodes[0]!).position).toEqual(nativeNode(graph.nodes[0]!).position)
  })
  it('retains meaningful Agent edits mixed with local layout', () => {
    const { context, graph } = moved()
    const edit = changeDraftAgent(newNextDraft(context, 'agent-test'), { ...context.agents[0]!.agent, name: 'Renamed Agent' }, graph)
    expect(nextDraftDirty(edit)).toBe(true)
    expect(draftOperations(context, edit.graph, edit.agentEdits)).toEqual([
      { type: 'agent.rename', agentId: 'agent-0', expectedAgentRevision: 3, name: 'Renamed Agent' },
    ])
  })
})
