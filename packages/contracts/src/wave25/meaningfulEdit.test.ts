import { describe, expect, it } from 'vitest'
import { executableNodeContent, preserveWorkflowGeometry, sameAuthoredWorkflow,
  sameExecutableWorkflow, sameWorkflowExceptGeometry } from './meaningfulEdit.js'
import { CurrentWorkflowNodeSchema } from './workflowShape.js'

const fixture = () => ({
  id: 'workflow', workspaceId: 'workspace', version: 7, executionSemanticsVersion: 3,
  createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z',
  nodes: [{ id: 'worker', agentId: 'agent', initialPrompt: 'Before', position: { x: 1, y: 2 } }],
  edges: [{ id: 'edge', source: 'worker', target: 'other', kind: 'execution' }],
  executionPolicy: { maxParallelism: 4, maxNodeExecutions: 10 }, approval: { handler: 'user' },
})

describe('shared executable/presentation boundary', () => {
  it('treats manual placement as geometry and preserves it across executable edits', () => {
    const before = fixture()
    const manual = { ...before, nodes: [{ ...before.nodes[0]!, name: 'Worker',
      position: { ...before.nodes[0]!.position, manual: true } }] }
    const named = { ...before, nodes: [{ ...before.nodes[0]!, name: 'Worker' }] }
    expect(CurrentWorkflowNodeSchema.parse(manual.nodes[0]!)).toEqual(manual.nodes[0])
    expect(sameAuthoredWorkflow(named, manual)).toBe(true)
    expect(sameExecutableWorkflow(named, manual)).toBe(true)
    expect(sameWorkflowExceptGeometry(named, manual)).toBe(true)
    expect(executableNodeContent(manual.nodes[0]!)).not.toHaveProperty('position')
    expect(preserveWorkflowGeometry(named, manual).nodes[0]).toEqual(manual.nodes[0])
    expect(preserveWorkflowGeometry(manual, named).nodes[0]).toEqual(named.nodes[0])
  })
  it('exempts positions and server stamps from execution comparisons', () => {
    const before = fixture(), after = structuredClone(before)
    after.version++; after.updatedAt = '2026-09-24T01:00:00Z'; after.nodes[0]!.position = { x: 700, y: -100 }
    expect(sameExecutableWorkflow(before, after)).toBe(true)
    expect(sameWorkflowExceptGeometry(before, after)).toBe(false) // acknowledgement still fences metadata
    expect(sameWorkflowExceptGeometry(before, { ...before, nodes: after.nodes })).toBe(true)
  })
  it.each(['initialPrompt', 'agentId', 'choice', 'tools', 'approval', 'executionSettings', 'newExecutionField'])('keeps node %s meaningful', (field) => {
    const before = fixture(), node = { ...before.nodes[0]!, [field]: 'changed' }
    expect(sameExecutableWorkflow(before, { ...before, nodes: [node] })).toBe(false)
  })
  it.each(['edges', 'approval', 'executionPolicy', 'entryNodeId', 'requiredAgentCount', 'executionCondition', 'repeatRules'])('keeps workflow %s meaningful', (field) => {
    const before = fixture()
    expect(sameExecutableWorkflow(before, { ...before, [field]: 'changed' })).toBe(false)
  })
  it('does not mutate sources when dropping the allowed geometry fields', () => {
    const before = fixture(), copy = structuredClone(before)
    expect(executableNodeContent(before.nodes[0]!)).not.toHaveProperty('position')
    expect(before).toEqual(copy)
  })
  it('exempts UI card dimensions and preserves no-op references', () => {
    const before = fixture(), resized = { ...before, nodes: [{ ...before.nodes[0]!, width: 600, height: 320 }] }
    expect(sameExecutableWorkflow(before, resized)).toBe(true)
    expect(preserveWorkflowGeometry(before, before)).toBe(before)
    expect(preserveWorkflowGeometry(before, resized).nodes[0]).toMatchObject({ width: 600, height: 320 })
  })
  it.each(['name', 'label'])('keeps node %s edits dirty without changing execution', (field) => {
    const before = fixture()
    const renamed = { ...before, nodes: [{ ...before.nodes[0]!, [field]: 'Renamed worker' }] }
    expect(sameExecutableWorkflow(before, renamed)).toBe(true)
    expect(sameAuthoredWorkflow(before, renamed)).toBe(false)
    expect(sameWorkflowExceptGeometry(before, renamed)).toBe(false)
    expect(executableNodeContent(renamed.nodes[0]!)).toHaveProperty(field, 'Renamed worker')
    expect(before.nodes[0]).not.toHaveProperty(field)
  })
  it('preserves independent positions on mixed discard without reviving removed nodes', () => {
    const before = fixture(), displayed = { ...before, nodes: [
      { ...before.nodes[0]!, initialPrompt: 'Staged', position: { x: 800, y: 900 } },
      { id: 'new-node', agentId: 'new-agent', initialPrompt: 'New', position: { x: 20, y: 30 } },
    ] }
    const restored = preserveWorkflowGeometry(before, displayed)
    expect(restored.nodes).toEqual([{ ...before.nodes[0]!, position: { x: 800, y: 900 } }])
    expect(displayed.nodes[0]!.initialPrompt).toBe('Staged')
    expect(before.nodes[0]!.position).toEqual({ x: 1, y: 2 })
  })
})
