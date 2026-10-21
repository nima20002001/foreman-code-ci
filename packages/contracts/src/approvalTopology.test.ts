import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { directApprovalConnection } from './approvalTopology.js'

const nodes = [
  { id: 'review', agentId: 'orchestrator' },
  { id: 'worker', agentId: 'coder' },
  { id: 'middle', agentId: 'helper' },
  { id: 'other-occurrence', agentId: 'coder' },
]
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target, kind: 'approval' as const })
const check = (edges: ReturnType<typeof edge>[], requestingNode = 'worker', graphNodes = nodes) =>
  directApprovalConnection({ nodes: graphNodes, edges }, requestingNode, 'coder', 'orchestrator')

describe('immutable exact-node approval adjacency', () => {
  it('accepts a direct outgoing edge', () => assert.deepEqual(check([edge('review', 'worker')]), {
    requestingNodeId: 'worker', orchestratorNodeId: 'review',
  }))
  it('accepts a direct incoming edge without changing execution direction', () => assert.ok(check([edge('worker', 'review')])))
  it('rejects transitive-only connectivity', () => assert.equal(check([edge('review', 'middle'), edge('middle', 'worker')]), undefined))
  it('rejects an unconnected node in the same workflow', () => assert.equal(check([edge('review', 'middle')]), undefined))
  it('cannot borrow another occurrence of the same Agent', () => {
    assert.equal(check([edge('review', 'other-occurrence')]), undefined)
    assert.ok(check([edge('review', 'other-occurrence')], 'other-occurrence'))
  })
  it('rejects missing and mismatched requester identity', () => {
    assert.equal(check([edge('review', 'worker')], 'missing'), undefined)
    assert.equal(directApprovalConnection({ nodes, edges: [edge('review', 'worker')] }, 'worker', 'helper', 'orchestrator'), undefined)
  })
  it('rejects a self request', () => assert.equal(directApprovalConnection({ nodes, edges: [edge('review', 'review')] },
    'review', 'orchestrator', 'orchestrator'), undefined))
  it('fails closed for ambiguous reviewer occurrences', () => assert.equal(check([edge('review', 'worker')], 'worker',
    [...nodes, { id: 'another-review', agentId: 'orchestrator' }]), undefined))
  it('fails closed for duplicate requesting node IDs', () => assert.equal(check([edge('review', 'worker')], 'worker',
    [...nodes, { id: 'worker', agentId: 'coder' }]), undefined))
  it('does not mutate the saved graph', () => {
    const definition = { nodes: structuredClone(nodes), edges: [edge('review', 'worker')] }
    const before = structuredClone(definition)
    directApprovalConnection(definition, 'worker', 'coder', 'orchestrator')
    assert.deepEqual(definition, before)
  })
})
