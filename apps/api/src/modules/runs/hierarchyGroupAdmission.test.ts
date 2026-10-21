import { describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { COORDINATION_RESULT_PROTOCOL } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import type pg from 'pg'
import { hierarchyRequestedWork } from './hierarchyGroupAdmission.js'
import { parseHierarchyWorkResult, type HierarchyWorkResult } from './hierarchyResults.js'
import { hasWorkflowExecutionCapacityLocked } from './workflowExecutionBudget.js'

function fixture() {
  const saved = makeCurrentWorkflowFixture('hierarchy-planning', 'parallel')
  const [parent, ...children] = saved.version.definition.nodes
  const edges = children.map((child, index) => ({ id: `route-${index}`, kind: 'execution' as const,
    source: parent!.id, target: child.id }))
  const version: WorkflowVersionV3 = { ...saved.version, definition: { ...saved.version.definition,
    handoffs: { contractVersion: 1 }, hierarchy: { version: 1, masterNodeId: parent!.id,
      parents: children.map(child => ({ workflowNodeId: child.id, parentNodeId: parent!.id })) },
    nodes: [{ ...parent!, choice: { outcomes: edges.map((edge, index) => ({ outcome: `task_${index}`,
      target: { kind: 'edge' as const, relationshipId: edge.id } })) } }, ...children.map(child => ({
      id: child.id, agentId: child.agentId, name: child.name,
    }))], edges, executionPolicy: { maxNodeExecutions: 8, maxParallelism: 3 },
  } }
  const result: HierarchyWorkResult = { routing: { kind: 'delegate', requests: [
    { outcome: 'task_0', data: { task: 'Build the service' } },
    { outcome: 'task_2', data: { task: 'Find defects' } },
  ] }, data: { latestDeliverable: 'The agreed plan', remainingFindings: [] },
  summary: 'Two independent tasks', board: { kind: 'none', reason: 'no_changes' } }
  return { saved, version, parent: parent!, children, result }
}

describe('hierarchy delegation preparation', () => {
  it('selects only the named children and preserves distinct business inputs', () => {
    const f = fixture()
    expect(hierarchyRequestedWork(f.version, f.parent.id, f.result)).toEqual([
      { relationshipId: 'route-0', destinationNodeId: f.children[0]!.id, outcome: 'task_0',
        data: { task: 'Build the service' }, maximum: null },
      { relationshipId: 'route-2', destinationNodeId: f.children[2]!.id, outcome: 'task_2',
        data: { task: 'Find defects' }, maximum: null },
    ])
  })
  it('rejects a declared route that is not a direct child', () => {
    const f = fixture()
    f.version.definition.hierarchy!.parents = f.version.definition.hierarchy!.parents
      .filter(parent => parent.workflowNodeId !== f.children[2]!.id)
    expect(() => hierarchyRequestedWork(f.version, f.parent.id, f.result))
      .toThrowError(expect.objectContaining({ code: 'HIERARCHY_REQUEST_ROUTE_FORBIDDEN' }))
  })
  it('rejects two distinct outcome names targeting the same child', () => {
    const f = fixture()
    f.version.definition.edges[2] = { ...f.version.definition.edges[2]!, target: f.children[0]!.id }
    expect(() => hierarchyRequestedWork(f.version, f.parent.id, f.result))
      .toThrowError(expect.objectContaining({ code: 'HIERARCHY_REQUEST_ROUTE_FORBIDDEN' }))
  })
  it('parses hierarchy routing with either protocol while preserving the original result', () => {
    const f = fixture()
    const original = structuredClone(f.result)
    expect(parseHierarchyWorkResult({ outcome: 'succeeded', output: f.result }, f.version, f.parent.id, undefined))
      .toEqual(f.result)
    expect(parseHierarchyWorkResult({ outcome: 'succeeded', output: f.result }, f.version,
      f.parent.id, COORDINATION_RESULT_PROTOCOL)).toEqual(f.result)
    expect(f.result).toEqual(original)
  })
  it('keeps valid root findings for direction admission while rejecting outstanding children', () => {
    const f = fixture()
    const output: HierarchyWorkResult = { ...f.result, routing: { kind: 'finish' },
      data: { latestDeliverable: 'Draft', remainingFindings: ['Choose the scope'] } }
    expect(parseHierarchyWorkResult({ outcome: 'succeeded', output }, f.version,
      f.parent.id, COORDINATION_RESULT_PROTOCOL).data.remainingFindings).toEqual(['Choose the scope'])
    expect(() => parseHierarchyWorkResult({ outcome: 'succeeded', output }, f.version,
      f.parent.id, COORDINATION_RESULT_PROTOCOL, ['outstanding-child'])).toThrow('HIERARCHY_WORK_UNRESOLVED')
  })
  it('requires capacity for all children and the parent summary together', async () => {
    const f = fixture()
    const query = vi.fn<GraphTransactionSql['query']>()
      .mockResolvedValue({ rows: [{ total: '4' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
    const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
    await connection.transaction(async sql => {
      expect(await hasWorkflowExecutionCapacityLocked(sql, f.saved.run.id, f.version, null, 4)).toBe(true)
      expect(await hasWorkflowExecutionCapacityLocked(sql, f.saved.run.id, f.version, null, 5)).toBe(false)
    })
  })
})
