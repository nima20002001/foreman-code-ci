import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { GraphDraftOperationV3Schema, WorkflowDefinitionV3Schema } from '@foreman-code/contracts/wave25'
import { fixture } from '../graph/nextDraft/core.cases'
import { authoringHints, draftOperations, removeNode } from '../graph/nextDraft/model'
import { stageAgentEdits } from '../graph/nextDraft/agentEdits'
import { newNextDraft, undoNextDraft } from '../graph/nextDraft/state'
import { applyMasterHierarchy, removeMasterHierarchy, reparentHierarchyWorker, stageHierarchyAgent } from './authoring'

function draft() {
  const context = fixture(['orchestrator', 'orchestrator', 'coder'])
  context.agents = context.agents.map(record => ({ ...record, agent: { ...record.agent,
    harness: 'codex', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex } }))
  return newNextDraft(context, 'hierarchy-editor')
}

describe('explicit Master authoring through the ordinary staged Agent journal', () => {
  it('adopts an existing Agent as Master atomically and preserves its saved configuration evidence', () => {
    const original = draft()
    const changed = applyMasterHierarchy(original, 'node-0', { 'node-2': 'node-1' })
    expect(changed.graph.hierarchy).toEqual({ version: 1, masterNodeId: 'node-0', parents: [
      { workflowNodeId: 'node-1', parentNodeId: 'node-0' }, { workflowNodeId: 'node-2', parentNodeId: 'node-1' },
    ] })
    expect(changed.graph.entryNodeId).toBe('node-0')
    expect(changed.graph.edges).toEqual(expect.arrayContaining(original.graph.edges))
    const workerRoute = changed.graph.edges.find(edge => edge.kind === 'execution' && edge.source === 'node-1' && edge.target === 'node-2')!
    expect(workerRoute).toBeDefined()
    expect(changed.graph.nodes[1]!.choice?.outcomes).toContainEqual(expect.objectContaining({ target: { kind: 'edge', relationshipId: workerRoute.id } }))
    for (const edge of original.graph.edges) expect(changed.graph.nodes[0]!.choice?.outcomes)
      .toContainEqual(expect.objectContaining({ target: { kind: 'edge', relationshipId: edge.id } }))
    expect(stageAgentEdits(changed)).toMatchObject([{ baseRevision: 3, agent: {
      id: 'agent-0', productRole: 'master', configurationVersionId: 'configuration-0',
    } }])
    const operation = draftOperations(changed.context, changed.graph, changed.agentEdits)
      .find(item => item.type === 'agent.configure')
    expect(GraphDraftOperationV3Schema.parse(operation)).toMatchObject({ type: 'agent.configure',
      agentId: 'agent-0', expectedAgentRevision: 3, productRole: 'master' })
    expect(original.context.agents[0]!.agent.productRole).toBe('orchestrator')
    expect(undoNextDraft(changed).graph).toEqual(original.graph)
    expect(undoNextDraft(changed).agentEdits).toEqual({})
  })

  it('replaces the Master only with explicit Worker reassignment and one undo step', () => {
    const first = applyMasterHierarchy(draft(), 'node-0', { 'node-2': 'node-1' })
    expect(() => applyMasterHierarchy(first, 'node-1', { 'node-2': 'node-1' })).toThrow('Choose an Orchestrator')
    const replaced = applyMasterHierarchy(first, 'node-1', { 'node-2': 'node-0' })
    expect(replaced.agentEdits?.['agent-0']).toBeUndefined()
    expect(replaced.agentEdits?.['agent-1']).toMatchObject({ productRole: 'master', configurationVersionId: 'configuration-1' })
    expect(replaced.graph.hierarchy).toMatchObject({ masterNodeId: 'node-1', parents: [
      { workflowNodeId: 'node-0', parentNodeId: 'node-1' }, { workflowNodeId: 'node-2', parentNodeId: 'node-0' },
    ] })
    expect(replaced.history).toHaveLength(first.history.length + 1)
    expect(undoNextDraft(replaced).graph).toEqual(first.graph)
    expect(undoNextDraft(replaced).agentEdits?.['agent-0']?.productRole).toBe('master')
    expect(replaced.graph.edges).toEqual(expect.arrayContaining(first.graph.edges))
    expect(replaced.graph.edges).toContainEqual(expect.objectContaining({ kind: 'execution', source: 'node-1', target: 'node-0' }))
    expect(applyMasterHierarchy(replaced, 'node-1', { 'node-2': 'node-0' }).graph).toEqual(replaced.graph)
  })

  it('removes reporting explicitly without deleting routes or silently orphaning Workers', () => {
    const first = applyMasterHierarchy(draft(), 'node-0', { 'node-2': 'node-1' })
    expect(() => removeNode(first.graph, 'node-0')).toThrow('explicitly remove')
    expect(() => removeNode(first.graph, 'node-1')).toThrow('Move this Orchestrator')
    expect(removeNode(first.graph, 'node-2').hierarchy?.parents).toEqual([
      { workflowNodeId: 'node-1', parentNodeId: 'node-0' },
    ])
    const ordinary = removeMasterHierarchy(first)
    expect(ordinary.graph.hierarchy).toBeUndefined()
    expect(ordinary.graph.edges).toBe(first.graph.edges)
    expect(ordinary.graph.entryNodeId).toBe(first.graph.entryNodeId)
    expect(ordinary.agentEdits?.['agent-0']).toBeUndefined()
  })

  it('refuses hidden role changes to multiple references and retains unapplied settings', () => {
    expect(() => applyMasterHierarchy(draft(), 'node-2', {})).toThrow('Choose an Orchestrator')
    const original = draft()
    original.graph = { ...original.graph, nodes: [...original.graph.nodes, {
      id: 'reused', agentId: 'agent-0', name: 'Second reference',
    }] }
    expect(() => applyMasterHierarchy(original, 'node-0', { 'node-2': 'node-1' })).toThrow('used by several nodes')
    expect(original.agentEdits).toBeUndefined()
    const pending = draft()
    pending.agentForms = { 'node-0': { base: '{}', name: 'Still typing', prompt: '',
      editor: { configuration: DEFAULT_HARNESS_DEFAULTS.codex, shellEnvironmentText: '{}', mcpText: '{ unfinished' } } }
    expect(() => applyMasterHierarchy(pending, 'node-0', { 'node-2': 'node-1' })).toThrow('Apply the open settings')
    expect(pending.agentForms['node-0']!.name).toBe('Still typing')
  })

  it('stages new Agents without saved pins or publishing and requires an explicit Worker parent', () => {
    const first = applyMasterHierarchy(draft(), 'node-0', { 'node-2': 'node-1' })
    const worker = { id: 'new-worker', name: 'Private Worker', productRole: 'coder' as const,
      harness: 'codex' as const, harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex }
    expect(() => stageHierarchyAgent(first, worker, 'new-node')).toThrow('Choose an Orchestrator')
    const added = stageHierarchyAgent(first, worker, 'new-node', 'node-1')
    expect(stageAgentEdits(added)).toContainEqual({ agent: worker, baseRevision: null })
    expect(added.context.agents.some(record => record.agent.id === worker.id)).toBe(false)
    expect(added.graph.hierarchy?.parents).toContainEqual({ workflowNodeId: 'new-node', parentNodeId: 'node-1' })
    expect(undoNextDraft(added).graph).toEqual(first.graph)
  })

  it('reuses an existing handoff when a Worker explicitly changes reporting parent', () => {
    const original = newNextDraft(fixture(['orchestrator', 'orchestrator', 'orchestrator', 'coder']), 'reparent-editor')
    const initial = applyMasterHierarchy(original, 'node-0', { 'node-3': 'node-1' })
    const graph = reparentHierarchyWorker(initial.graph, 'node-3', 'node-2')
    expect(graph.edges).toEqual(expect.arrayContaining(initial.graph.edges))
    const route = graph.edges.find(edge => edge.kind === 'execution' && edge.source === 'node-2' && edge.target === 'node-3')!
    expect(graph.nodes[2]!.choice?.outcomes).toContainEqual(expect.objectContaining({ target: { kind: 'edge', relationshipId: route.id } }))
    expect(graph.hierarchy?.parents).toContainEqual({ workflowNodeId: 'node-3', parentNodeId: 'node-2' })
    expect(graph.hierarchy?.parents).not.toContainEqual({ workflowNodeId: 'node-3', parentNodeId: 'node-1' })
    expect(reparentHierarchyWorker(graph, 'node-3', 'node-2')).toEqual(graph)
  })

  it('reuses a two-way connection during Master replacement without changing its ID, permitted work directions or named references', () => {
    const original = draft(), edge = original.graph.edges[0]!
    original.graph.edges[0] = { ...edge, workRequestDirection: 'both' }
    const first = applyMasterHierarchy(original, 'node-0', { 'node-2': 'node-1' })
    const replaced = applyMasterHierarchy(first, 'node-1', { 'node-2': 'node-0' })
    expect(replaced.graph.edges).toHaveLength(first.graph.edges.length)
    expect(replaced.graph.edges.find(item => item.id === edge.id)).toMatchObject({ source: 'node-1', target: 'node-0', workRequestDirection: 'both' })
    expect(replaced.graph.nodes[0]!.choice?.outcomes).toEqual(expect.arrayContaining(first.graph.nodes[0]!.choice!.outcomes))
    expect(WorkflowDefinitionV3Schema.safeParse(replaced.graph).success).toBe(true)
    expect(authoringHints(replaced.graph, replaced.context, replaced.agentEdits)).toEqual([])
  })
})
