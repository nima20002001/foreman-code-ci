import { describe, expect, it } from 'vitest'
import { sameExecutableWorkflow, WorkflowDefinitionV3Schema } from '@foreman-code/contracts/wave25'
import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { fixture } from './core.cases'
import { discardMeaningfulChanges, draftOperations, mergeAcknowledgement } from './model'
import { editNextDraft, newNextDraft, nextDraftDirty, redoNextDraft, undoNextDraft } from './state'
import { worktreeFixture } from '../../workflow-board/worktree.fixtures'

const settings = { rootBinding: worktreeFixture('workspace').rootBinding, branchPrefix: 'foreman/site' }

describe('worktree draft changes', () => {
  it('emits the shared executable operation and round-trips through the saved definition schema', () => {
    const context = fixture()
    const graph = { ...context.draft.graph, defaultWorktree: settings }
    expect(draftOperations(context, graph)).toEqual([{ type: 'workflow.set_worktree', worktree: settings }])
    expect(sameExecutableWorkflow(context.draft.graph, graph)).toBe(false)
    expect(WorkflowDefinitionV3Schema.parse(JSON.parse(JSON.stringify(graph))).defaultWorktree).toEqual(settings)
  })

  it('undoes, redoes and discards the worktree setting while keeping independent geometry', () => {
    const context = fixture()
    const original = newNextDraft(context, 'worktree-draft')
    const edited = editNextDraft(original, graph => ({ ...graph, defaultWorktree: settings,
      nodes: graph.nodes.map((node, index) => index ? node : { ...node, position: { x: 950, y: 400 } }) }))
    expect(nextDraftDirty(edited)).toBe(true)
    const undone = undoNextDraft(edited)
    expect(undone.graph.defaultWorktree).toBeUndefined()
    expect(redoNextDraft(undone).graph.defaultWorktree).toEqual(settings)
    const discarded = discardMeaningfulChanges(context, edited.graph)
    expect(discarded).not.toHaveProperty('defaultWorktree')
    expect(discarded.nodes[0]?.position).toEqual({ x: 950, y: 400 })
    expect(nextDraftDirty({ ...edited, graph: discarded })).toBe(false)
  })

  it('clears defaults with null and node overrides with a replacement that omits their properties', () => {
    const context = fixture()
    context.draft.graph.defaultWorktree = settings
    nativeNode(context.draft.graph.nodes[0]).worktree = { branchPrefix: 'foreman/override' }
    const graph = structuredClone(context.draft.graph)
    delete graph.defaultWorktree
    delete nativeNode(graph.nodes[0]).worktree
    const operations = draftOperations(context, graph)
    expect(operations).toContainEqual({ type: 'workflow.set_worktree', worktree: null })
    expect(operations).toContainEqual({ type: 'node.replace_v3', node: graph.nodes[0] })
    expect(graph.nodes[0]).not.toHaveProperty('worktree')
  })

  it('keeps a newer local selection through an uncertain Save acknowledgement', () => {
    const context = fixture()
    const sent = { ...context.draft.graph, defaultWorktree: settings }
    const newer = { ...sent, defaultWorktree: { ...settings, branchPrefix: 'foreman/newer' } }
    const saved = { ...sent, version: 2 }
    expect(mergeAcknowledgement(newer, sent, saved).defaultWorktree?.branchPrefix).toBe('foreman/newer')
    expect(mergeAcknowledgement(sent, sent, saved).defaultWorktree).toEqual(settings)
  })
})
