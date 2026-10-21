import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { type Agent, type RunNodeLiveActivity } from '@foreman-code/contracts'
import { type WorkflowDefinitionV3 as WorkflowDefinition } from '@foreman-code/contracts/wave25'
import { workflowToGraph } from './mapper'

const workflow = { id: 'workflow', workspaceId: 'workspace', name: 'Workflow', executionSemanticsVersion: 3, entryNodeId: 'first', requiredAgentCount: 2,
  executionCondition: { kind: 'manual' as const },
  nodes: [{ id: 'first', agentId: 'same-agent' }, { id: 'second', agentId: 'same-agent' }], edges: [],
} as WorkflowDefinition
const agents = [{ id: 'same-agent', name: 'Agent', status: 'working' }] as unknown as Agent[]
const activity: RunNodeLiveActivity = { workflowNodeId: 'first', agentId: 'same-agent', state: 'working',
  action: { kind: 'reading_file', label: 'Reading file…' }, event: { id: 'event-1', sequence: '1' } }

describe('exact-node live graph mapping', () => {
  it('does not copy an Agent’s activity to another occurrence', () => {
    const graph = workflowToGraph({ workflow, agents }, { runActive: true, liveActivitiesByNodeId: new Map([['first', activity]]) })
    assert.deepEqual(nativeNode(graph.nodes[0]!).data.liveActivity, activity)
    assert.equal(nativeNode(graph.nodes[1]!).data.liveActivity, undefined)
  })
  it('never maps historical run activity into the live graph', () => {
    const graph = workflowToGraph({ workflow, agents }, { runActive: false, liveActivitiesByNodeId: new Map([['first', activity]]) })
    assert.ok(graph.nodes.every((node) => nativeNode(node).data.liveActivity === undefined))
  })
  it('ignores a snapshot for a replaced Agent on the same node ID', () => {
    const graph = workflowToGraph({ workflow, agents }, { runActive: true,
      liveActivitiesByNodeId: new Map([['first', { ...activity, agentId: 'previous-agent' }]]) })
    assert.equal(nativeNode(graph.nodes[0]!).data.liveActivity, undefined)
  })
  it('does not fabricate live evidence from a global Agent status or a completed step', () => {
    const graph = workflowToGraph({ workflow, agents }, { runActive: true, runStatesByNodeId: new Map([['first', 'completed']]) })
    assert.ok(graph.nodes.every((node) => nativeNode(node).data.liveActivity === undefined))
  })
})
