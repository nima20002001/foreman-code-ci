import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { pinnedNodeStates, pinnedTopology, runningIntervalChecks, type PinnedNodeDisplayCut } from './pinnedTopology'

describe('immutable canvas display projection', () => {
  it('uses only saved node names and configuration pins', () => {
    const { version } = makeCurrentWorkflowFixture('pinned', 'sequential')
    const result = pinnedTopology(version)
    expect(result.nodes.map((node) => [node.id, node.label, nativeNode(node).configurationId])).toEqual(
      version.definition.nodes.map((node) => [node.id, node.name, version.agentConfigurationVersionIds[node.agentId]]))
    expect(result.edges).toBe(version.definition.edges)
    expect(result.nodes.filter((node) => node.entry).map((node) => node.id)).toEqual([version.entryNodeId])
  })

  it('keeps a node on its graph state while interval checks run and shows its saved interval', () => {
    const { version } = makeCurrentWorkflowFixture('interval-pinned', 'single')
    nativeNode(version.definition.nodes[0]!).interval = { everySeconds: 300 }
    expect(nativeNode(pinnedTopology(version).nodes[0])?.intervalSeconds).toBe(300)
    const identity = (executionId: string) => ({ workflowNodeId: version.definition.nodes[0]!.id, executionId,
      agentId: 'agent', agentConfigurationVersionId: 'cfg', attempt: 1, occurrence: null })
    const cut: PinnedNodeDisplayCut = { state: { resolutions: [], executions: [
      { identity: identity('graph'), state: 'completed', resultOutcome: 'succeeded' },
      { identity: identity('check'), state: 'running', resultOutcome: null, tickIndex: 1 },
    ] } }
    expect(pinnedNodeStates(cut).get(version.definition.nodes[0]!.id)?.label).toBe('succeeded')
    expect(runningIntervalChecks(cut).get(version.definition.nodes[0]!.id)).toEqual({ check: 1, queued: false })
    const finished: PinnedNodeDisplayCut = { state: { resolutions: [], executions: cut.state.executions
      .map((fact) => ({ ...fact, state: 'completed' as const, resultOutcome: 'succeeded' as const })) } }
    expect(runningIntervalChecks(finished).size).toBe(0)
  })

  it('does not synthesize an ordinary repeat plan or occurrence', () => {
    const { version } = makeCurrentWorkflowFixture('ordinary-pinned', 'single')
    const original = JSON.stringify(version)
    const result = pinnedTopology(version)
    expect(nativeNode(result.nodes[0])?.blockId).toBeUndefined()
    expect(version.definition).not.toHaveProperty('repeat')
    expect(JSON.stringify(version)).toBe(original)
    expect(pinnedNodeStates().size).toBe(0)
  })

  it('retains only the repeat blocks declared in this version', () => {
    const { version } = makeCurrentWorkflowFixture('repeat-pinned', 'repeat')
    expect(pinnedTopology(version).nodes.every((node) => node.blockId === 'repair')).toBe(true)
    const { repeat: _repeat, ...definition } = version.definition
    void _repeat
    const ordinary = WorkflowVersionV3Schema.parse({ ...version, definition })
    expect(pinnedTopology(ordinary).nodes.every((node) => node.blockId === undefined)).toBe(true)
  })

  it('keeps a saved position and makes unsaved geometry fallback deterministic without mutation', () => {
    const { version } = makeCurrentWorkflowFixture('position-pinned')
    nativeNode(version.definition.nodes[0]!).position = { x: 127, y: -41 }
    const original = JSON.stringify(version)
    expect(pinnedTopology(version).nodes[0]?.position).toEqual({ x: 127, y: -41 })
    expect(pinnedTopology(version)).toEqual(pinnedTopology(version))
    expect(nativeNode(version.definition.nodes[1])).not.toHaveProperty('position')
    expect(JSON.stringify(version)).toBe(original)
  })

  it('orders ordinary technical attempts without turning them into business rounds', () => {
    const { identities } = makeCurrentWorkflowFixture('attempt-pinned')
    const identity = identities[0]!
    const cut: PinnedNodeDisplayCut = { state: { resolutions: [], executions: [
      { identity: { ...identity, attempt: 3, occurrence: null }, state: 'running', resultOutcome: null },
      { identity: { ...identity, attempt: 1, occurrence: null }, state: 'completed', resultOutcome: 'succeeded' },
    ] } }
    expect(pinnedNodeStates(cut).get(identity.workflowNodeId)).toEqual({ label: 'running', occurrenceIndex: 0, attempt: 3 })
  })

  it('orders real occurrence before attempt, so an earlier successful retry cannot label a later round', () => {
    const { identities, scope } = makeCurrentWorkflowFixture('occurrence-pinned', 'repeat')
    const identity = identities[0]!
    const occurrence = (index: number) => ({ scope, blockId: 'repair', occurrenceId: `occ-${index}`, occurrenceIndex: index })
    const cut: PinnedNodeDisplayCut = { state: { resolutions: [], executions: [
      { identity: { ...identity, attempt: 5, occurrence: occurrence(1) }, state: 'completed', resultOutcome: 'succeeded' },
      { identity: { ...identity, attempt: 1, occurrence: occurrence(2) }, state: 'waiting', resultOutcome: null },
    ] } }
    expect(pinnedNodeStates(cut).get(identity.workflowNodeId)).toEqual({ label: 'waiting', occurrenceIndex: 2, attempt: 1 })
  })

  it('keeps a later durable exclusion instead of an earlier execution badge', () => {
    const { identities, scope } = makeCurrentWorkflowFixture('resolution-pinned', 'repeat')
    const identity = identities[0]!
    const occurrence = (index: number) => ({ scope, blockId: 'repair', occurrenceId: `occ-${index}`, occurrenceIndex: index })
    const cut: PinnedNodeDisplayCut = { state: {
      resolutions: [{ ref: { nodeId: identity.workflowNodeId, occurrence: occurrence(2) }, value: { resolution: 'excluded' } }],
      executions: [{ identity: { ...identity, occurrence: occurrence(1) }, state: 'completed', resultOutcome: 'succeeded' }],
    } }
    expect(pinnedNodeStates(cut).get(identity.workflowNodeId)?.label).toBe('excluded')
  })

  it('projects a maximum-size saved graph without consulting draft or Agent stores', () => {
    const { version } = makeCurrentWorkflowFixture('large-pinned', 'single')
    const nodes = Array.from({ length: 1000 }, (_, index) => ({ id: `n-${index}`, agentId: `a-${index}`, name: `Saved ${index}` }))
    const edges = nodes.slice(1).map((node, index) => ({ id: `e-${index}`, kind: 'execution' as const, source: nodes[index]!.id, target: node.id }))
    const large = WorkflowVersionV3Schema.parse({ ...version, entryNodeId: nodes[0]!.id,
      agentConfigurationVersionIds: Object.fromEntries(nodes.map((node) => [node.agentId, `cfg-${node.agentId}`])),
      definition: { ...version.definition, entryNodeId: nodes[0]!.id, nodes, edges,
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1000 } } })
    expect(pinnedTopology(large).nodes).toHaveLength(1000)
    expect(pinnedTopology(large).edges).toHaveLength(999)
  })
})
