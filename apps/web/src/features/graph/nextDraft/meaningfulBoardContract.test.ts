import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { fixture } from './core.cases'
import { draftOperations, hasLocalChanges } from './model'
import { editNextDraft, newNextDraft, nextDraftDirty, redoNextDraft, undoNextDraft } from './state'
import { changeDraftAgent, configureAgentOperations, hasAgentEdits } from './agentEdits'

describe('frozen board edit classification', () => {
  const movedFixture = () => {
    const context = fixture()
    const moved = { ...context.draft.graph, nodes: context.draft.graph.nodes.map((node, index) => index === 0
      ? { ...node, position: { x: 730, y: -180 } } : node) }
    return { context, moved }
  }

  it('keeps node layout out of executable dirtiness', () => {
    const { context, moved } = movedFixture()
    const edit = editNextDraft(newNextDraft(context, 'layout-only'), () => moved)

    expect(hasLocalChanges(context, moved)).toBe(false)
    expect(nextDraftDirty(edit)).toBe(false)
    expect(context.draft.revision).toBe(7)
  })

  it('does not serialize layout as a workflow operation', () => {
    const { context, moved } = movedFixture()
    expect(draftOperations(context, moved)).toEqual([])
  })

  it('keeps an unsaved node name in Save operations and undo history', () => {
    const context = fixture()
    const graph = { ...context.draft.graph, nodes: context.draft.graph.nodes.map((node, index) => index === 0
      ? { ...node, name: 'Renamed worker' } : node) }
    const edit = editNextDraft(newNextDraft(context, 'node-name'), () => graph)
    expect(hasLocalChanges(context, graph)).toBe(true)
    expect(nextDraftDirty(edit)).toBe(true)
    expect(draftOperations(context, graph)).toContainEqual(expect.objectContaining({
      type: 'node.replace_v3', node: expect.objectContaining({ name: 'Renamed worker' }),
    }))
    expect(nextDraftDirty(undoNextDraft(edit))).toBe(false)
    expect(nextDraftDirty(redoNextDraft(undoNextDraft(edit)))).toBe(true)
  })

  it('does not push Undo for identical values, undefined wrappers or server stamps', () => {
    const base = newNextDraft(fixture(), 'no-op')
    for (const update of [structuredClone(base.graph), { ...base.graph, description: undefined },
      { ...base.graph, version: 99, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' }]) {
      expect(editNextDraft(base, () => update)).toBe(base)
    }
    expect(base.history).toEqual([])
    expect(nextDraftDirty(base)).toBe(false)
  })

  it('compares acknowledged local drafts to their saved content rather than bookkeeping revisions', () => {
    const context = fixture()
    const savedDraft = structuredClone(context.draft)
    context.savedDraft = savedDraft
    context.draft = { ...context.draft, revision: 8, graph: { ...context.draft.graph, name: 'Acknowledged local edit' } }
    const base = newNextDraft(context, 'saved-baseline')
    expect(nextDraftDirty(base)).toBe(true)
    const restored = editNextDraft(base, () => structuredClone(savedDraft.graph))
    expect(nextDraftDirty(restored)).toBe(false)
    expect(nextDraftDirty(undoNextDraft(restored))).toBe(true)
    expect(nextDraftDirty(redoNextDraft(undoNextDraft(restored)))).toBe(false)
    expect(restored.context.draft.revision).toBe(8)
    expect(restored.context.draft.baseWorkflowVersionId).toBe(savedDraft.baseWorkflowVersionId)
    expect(nextDraftDirty({ ...restored, pending: { kind: 'save', commandId: 'exact-command',
      workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft', expectedRevision: 8, executionSemanticsVersion: 3 } })).toBe(true)
  })

  it('keeps history for authored geometry and hides dirtiness after undoing all meaning', () => {
    const { context, moved } = movedFixture()
    const base = newNextDraft(context, 'undo-meaning')
    const geometry = editNextDraft(base, () => moved)
    expect(geometry.history).toHaveLength(1)
    expect(nextDraftDirty(geometry)).toBe(false)
    const renamed = editNextDraft(geometry, (graph) => ({ ...graph, name: 'Edited workflow' }))
    const undone = undoNextDraft(renamed)
    expect(nextDraftDirty(renamed)).toBe(true)
    expect(nextDraftDirty(undone)).toBe(false)
    expect(undone.graph.nodes[0]!.position).toEqual(moved.nodes[0]!.position)
    expect(nextDraftDirty(redoNextDraft(undone))).toBe(true)
  })

  it('does not stage normalized Agent defaults or metadata that emit no operations', () => {
    const context = fixture(), base = newNextDraft(context, 'agent-no-op'), agent = context.agents[0]!.agent
    const normalized = { ...agent, prompt: {}, assignedSkills: [],
      createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' }
    expect(configureAgentOperations(context, base.graph, { [agent.id]: normalized })).toEqual([])
    expect(changeDraftAgent(base, normalized, structuredClone(base.graph))).toBe(base)
    expect(nextDraftDirty({ ...base, agentEdits: { [agent.id]: normalized } })).toBe(false)
    const edited = changeDraftAgent(base, { ...normalized, name: 'Edited Agent' }, base.graph)
    expect(nextDraftDirty(edited)).toBe(true)
    expect(nextDraftDirty(changeDraftAgent(edited, normalized, base.graph))).toBe(false)
    expect(nextDraftDirty(undoNextDraft(edited))).toBe(false)
    expect(nextDraftDirty(redoNextDraft(undoNextDraft(edited)))).toBe(true)
  })

  it('distinguishes Agent runtime projections from persisted harness settings', () => {
    const context = fixture()
    context.agents[0]!.agent.harnessConfiguration = DEFAULT_HARNESS_DEFAULTS.codex
    const base = newNextDraft(context, 'agent-configuration'), agent = context.agents[0]!.agent
    const projected = { ...agent, harness: 'codex' as const, model: 'display model', effort: 'high' as const,
      fastMode: true, status: 'working' as const, activeRunId: 'display-run', updatedAt: '2026-10-02T00:00:00Z' }
    expect(changeDraftAgent(base, projected, base.graph)).toBe(base)
    const changed = { ...projected, harnessConfiguration: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'changed-model' } }
    const edit = changeDraftAgent(base, changed, base.graph)
    expect(nextDraftDirty(edit)).toBe(true)
    expect(configureAgentOperations(context, edit.graph, edit.agentEdits!)).toEqual([
      expect.objectContaining({ type: 'agent.configure', configuration: changed.harnessConfiguration }),
    ])
  })

  it('stages graph and Agent meaning without mutating the accepted context', () => {
    const context = fixture()
    const original = structuredClone(context)
    const graphEdit = editNextDraft(newNextDraft(context, 'semantic'), (graph) => ({ ...graph,
      nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, initialPrompt: 'Review evidence' } : node),
    }))
    const agentEdit = changeDraftAgent(graphEdit, { ...context.agents[0]!.agent, name: 'Reviewer' }, graphEdit.graph)

    expect(context).toEqual(original)
    expect(agentEdit.context.draft.revision).toBe(7)
    expect(nextDraftDirty(agentEdit)).toBe(true)
    expect(hasAgentEdits(agentEdit)).toBe(true)
    expect(draftOperations(context, agentEdit.graph, agentEdit.agentEdits)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'node.replace_v3' }),
      expect.objectContaining({ type: 'agent.rename', agentId: 'agent-0', name: 'Reviewer' }),
    ]))
  })
})
