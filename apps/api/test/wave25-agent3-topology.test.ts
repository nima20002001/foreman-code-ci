import { describe, expect, it } from 'vitest'
import type { NodeResolution, WorkflowRelationship, WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { compileExecutionTopology, decideExecutionAdmission, selectedTerminalResolutions } from '../src/modules/runs/topology.js'

function version(ids: string[], edges: WorkflowRelationship[], entry = ids[0]!): WorkflowVersionV3 {
  // This fixture exercises only compilation. Full executable acceptance has its own schema tests.
  return { entryNodeId: entry, definition: { entryNodeId: entry, nodes: ids.map((id) => ({ id })), edges } } as WorkflowVersionV3
}
function edge(id: string, source: string, target: string, kind: 'execution' | 'approval' = 'execution'): WorkflowRelationship {
  return { id, source, target, kind }
}
function resolution(id: string, selected: string[], unselected: string[] = []): NodeResolution {
  return {
    workflowNodeId: id, resolution: 'succeeded', execution: {
      executionId: `exec-${id}`, workflowNodeId: id, agentId: `agent-${id}`, agentConfigurationVersionId: `cfg-${id}`, attempt: 1,
    }, acceptedResultDigest: 'sha256:' + '0'.repeat(64), branchEnded: false,
    selectedRelationshipIds: selected, unselectedRelationshipIds: unselected, resolvedAt: '2026-09-21T00:00:00.000Z',
  }
}

describe('Wave 2.5 Agent 3 execution-only topology', () => {
  it('preserves authored entry after board reordering and excludes board-only components', () => {
    const graph = version(['entry', 'worker', 'board'], [edge('go', 'entry', 'worker'), edge('review', 'entry', 'board', 'approval')])
    const first = compileExecutionTopology(graph)
    graph.definition.nodes.reverse()
    const next = compileExecutionTopology(graph)
    expect(first.order).toEqual(['entry', 'worker'])
    expect(next.order).toEqual(first.order)
    expect(next.excluded).toEqual(['board'])
    expect(next.incoming.get('board')).toEqual([])
  })
  it('rejects an excluded-source dependency and incoming entry execution', () => {
    expect(() => compileExecutionTopology(version(['a', 'b', 'c'], [edge('ab', 'a', 'b'), edge('cb', 'c', 'b')]))).toThrow()
    expect(() => compileExecutionTopology(version(['a', 'b'], [edge('ba', 'b', 'a')]))).toThrow()
  })
  it('rejects a deleted entry instead of choosing the first remaining node', () => {
    expect(() => compileExecutionTopology(version(['b'], [], 'deleted'))).toThrow()
  })
  it('rejects cycles even in an unactivated board-only component', () => {
    expect(() => compileExecutionTopology(version(['a', 'b', 'c'], [edge('bc', 'b', 'c'), edge('cb', 'c', 'b')]))).toThrow()
  })
  it('does not treat a missing predecessor as an unselected predecessor', () => {
    const topology = compileExecutionTopology(version(['a', 'b', 'c', 'd'], [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('bd', 'b', 'd'), edge('cd', 'c', 'd')]))
    const resolved = new Map([['b', resolution('b', ['bd'])]])
    expect(decideExecutionAdmission(topology, 'd', resolved)).toEqual({ kind: 'waiting' })
    resolved.set('c', { ...resolution('c', [], ['cd']), resolution: 'skipped', execution: undefined, acceptedResultDigest: undefined })
    expect(decideExecutionAdmission(topology, 'd', resolved)).toMatchObject({ kind: 'run', selected: [{ id: 'bd' }] })
  })
  it('waits at an unequal diamond until the long incoming path resolves', () => {
    const topology = compileExecutionTopology(version(['a', 'short', 'long1', 'long2', 'join'], [
      edge('as', 'a', 'short'), edge('al', 'a', 'long1'), edge('ll', 'long1', 'long2'), edge('sj', 'short', 'join'), edge('lj', 'long2', 'join'),
    ]))
    const resolved = new Map([['short', resolution('short', ['sj'])], ['long1', resolution('long1', ['ll'])]])
    expect(decideExecutionAdmission(topology, 'join', resolved).kind).toBe('waiting')
    resolved.set('long2', resolution('long2', ['lj']))
    expect(decideExecutionAdmission(topology, 'join', resolved)).toMatchObject({ kind: 'run', selected: [{ id: 'lj' }, { id: 'sj' }] })
  })
  it('skips all-unselected joins and preserves selected terminal branch ends', () => {
    const topology = compileExecutionTopology(version(['a', 'b'], [edge('ab', 'a', 'b')]))
    const end = { ...resolution('a', [], ['ab']), branchEnded: true, outcome: 'pass' }
    expect(decideExecutionAdmission(topology, 'b', new Map([['a', end]]))).toEqual({ kind: 'skipped' })
    expect(selectedTerminalResolutions([end]).map((item) => item.workflowNodeId)).toEqual(['a'])
  })
  it('rejects contradictory selected/unselected evidence', () => {
    const topology = compileExecutionTopology(version(['a', 'b'], [edge('ab', 'a', 'b')]))
    expect(() => decideExecutionAdmission(topology, 'b', new Map([['a', resolution('a', ['ab'], ['ab'])]]))).toThrow()
  })
  it.each([300, 500])('computes a %i-node chain superstep budget independently of native concurrency', (count) => {
    const ids = Array.from({ length: count }, (_, i) => `n${i}`)
    const topology = compileExecutionTopology(version(ids, ids.slice(1).map((id, i) => edge(`e${i}`, ids[i]!, id))))
    expect(topology.order).toHaveLength(count)
    expect(topology.recursionLimit).toBe(count + 2)
    const wide = compileExecutionTopology(version(ids, ids.slice(1).map((id, i) => edge(`e${i}`, ids[0]!, id))))
    expect(wide.recursionLimit).toBe(4)
  })
})
