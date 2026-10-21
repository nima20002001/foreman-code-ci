import { expect, it } from 'vitest'
import {
  makeCurrentWorkflowFixture, repeatGraphTopologyV3, RepeatWorkflowVersionV1Schema,
  RepeatGraphExecutionV3Schema, RepeatGraphResolutionV3Schema,
} from '@foreman-code/contracts/wave25'
import { pinnedNodeStates, type PinnedNodeDisplayCut } from './inspect/pinnedTopology'
import { runNodeView } from './runFacts'

function branchingRepeat() {
  const fixture = makeCurrentWorkflowFixture('branch-state', 'repeat')
  const [entry, branch] = fixture.version.definition.nodes
  const branchB = { ...branch!, id: 'branch-b', agentId: 'agent-b', choice: undefined }
  const exit = { ...branch!, id: 'exit', agentId: 'agent-exit' }
  const version = RepeatWorkflowVersionV1Schema.parse({ ...fixture.version,
    agentConfigurationVersionIds: { ...fixture.version.agentConfigurationVersionIds,
      'agent-b': 'config-b', 'agent-exit': 'config-exit' },
    definition: { ...fixture.version.definition,
      nodes: [{ ...entry!, choice: { outcomes: [
        { outcome: 'a', target: { kind: 'edge', relationshipId: 'entry-a' } },
        { outcome: 'b', target: { kind: 'edge', relationshipId: 'entry-b' } },
      ] } }, { ...branch!, choice: undefined }, branchB, { ...exit, join: { mode: 'all' } }],
      edges: [
        { id: 'entry-a', kind: 'execution', source: entry!.id, target: branch!.id },
        { id: 'entry-b', kind: 'execution', source: entry!.id, target: branchB.id },
        { id: 'a-exit', kind: 'execution', source: branch!.id, target: exit.id },
        { id: 'b-exit', kind: 'execution', source: branchB.id, target: exit.id },
      ],
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 12 },
      repeat: { contractVersion: 1, blocks: [{ ...fixture.version.definition.repeat!.blocks[0]!,
        nodeIds: [entry!.id, branch!.id, branchB.id, exit.id], exitNodeId: exit.id }] },
    },
  })
  return { fixture, topology: repeatGraphTopologyV3(version) }
}

it('shows the later skipped repeat occurrence on both the popover and canvas', () => {
  const { fixture, topology } = branchingRepeat()
  const identity = fixture.identities[1]!
  const occurrence = (index: number) => ({ scope: fixture.scope, blockId: 'repair',
    occurrenceId: `occ-${index}`, occurrenceIndex: index })
  const execution = RepeatGraphExecutionV3Schema.parse({
    identity: { ...identity, occurrence: occurrence(1) }, state: 'completed', resultOutcome: 'succeeded',
    previousExecutionId: null, inputDigest: `sha256:${'1'.repeat(64)}`,
  })
  const resolution = RepeatGraphResolutionV3Schema.parse({
    ref: { nodeId: identity.workflowNodeId, occurrence: occurrence(2) },
    value: { workflowNodeId: identity.workflowNodeId, resolution: 'skipped', branchEnded: false,
      selectedRelationshipIds: [], unselectedRelationshipIds: ['a-exit'], resolvedAt: fixture.createdAt },
    outside: false, deferredRelationshipIds: [],
  })
  const record: PinnedNodeDisplayCut & { topology: typeof topology } = {
    topology, state: { executions: [execution], resolutions: [resolution] },
  }
  expect(pinnedNodeStates(record).get(identity.workflowNodeId)?.label).toBe('skipped')
  expect(runNodeView(record, true, identity.workflowNodeId, identity.agentId)).toEqual({
    state: 'idle', label: 'Skipped', inRun: true, activity: 'Business occurrence 2 · no execution',
  })
})

it('keeps execution attempt details when both facts describe the same completed occurrence', () => {
  const { fixture, topology } = branchingRepeat()
  const identity = fixture.identities[1]!
  const occurrence = { scope: fixture.scope, blockId: 'repair', occurrenceId: 'occ-1', occurrenceIndex: 1 }
  const record: PinnedNodeDisplayCut & { topology: typeof topology } = { topology, state: {
    resolutions: [{ ref: { nodeId: identity.workflowNodeId, occurrence }, value: { resolution: 'succeeded' } }],
    executions: [{ identity: { ...identity, occurrence }, state: 'completed', resultOutcome: 'succeeded' }],
  } }
  expect(runNodeView(record, true, identity.workflowNodeId, identity.agentId)).toEqual({
    state: 'completed', label: 'Completed', inRun: true, activity: 'Business occurrence 1 · technical attempt 1',
  })
  expect(runNodeView(record, true, identity.workflowNodeId, 'unrelated-agent').inRun).toBe(false)
})

it('shows the Agent awake on an interval check, then its graph state again', () => {
  const { fixture, topology } = branchingRepeat()
  const identity = fixture.identities[0]!
  const graph = { identity: { ...identity, occurrence: null }, state: 'completed' as const, resultOutcome: 'succeeded' as const }
  const check = { identity: { ...identity, executionId: 'check-2', occurrence: null }, state: 'running' as const, resultOutcome: null, tickIndex: 2 }
  const record = (executions: PinnedNodeDisplayCut['state']['executions']) => ({ topology, state: { resolutions: [], executions } })
  expect(runNodeView(record([graph, check]), true, identity.workflowNodeId, identity.agentId)).toEqual({
    state: 'running', label: 'Looping · loop 2', inRun: true })
  expect(runNodeView(record([graph, { ...check, state: 'completed', resultOutcome: 'succeeded' }]), true,
    identity.workflowNodeId, identity.agentId)).toEqual({ state: 'completed', label: 'Completed', inRun: true })
})
