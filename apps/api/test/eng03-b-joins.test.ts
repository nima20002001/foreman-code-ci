import { describe, expect, it } from 'vitest'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { graphHarness } from './helpers/eng04A1GraphHarness.js'

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('ENG-03 B join qualification (synthetic native work)', () => {
  it('waits for a slow unequal-depth selected path, skips an unselected path and binds exact results once in relationship order', async () => {
    const scenario = makeCurrentWorkflowFixture('eng03-joins-v3')
    const names = ['entry', 'short', 'long1', 'long2', 'unused', 'join']
    scenario.configurations = names.map((name) => ({ ...scenario.configurations[0]!, id: `cfg-${name}`, agentId: `agent-${name}` }))
    scenario.version.entryNodeId = scenario.version.definition.entryNodeId = 'entry'
    scenario.version.agentConfigurationVersionIds = Object.fromEntries(scenario.configurations.map((item) => [item.agentId, item.id]))
    scenario.run.agentConfigurationVersionIds = scenario.version.agentConfigurationVersionIds
    scenario.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: names.length }
    scenario.version.definition.nodes = names.map((name) => ({ id: name, agentId: `agent-${name}`, name,
      ...(name === 'long1' ? { choice: { outcomes: [
        { outcome: 'selected', target: { kind: 'edge' as const, relationshipId: 'long1-long2' } },
        { outcome: 'unused', target: { kind: 'edge' as const, relationshipId: 'long1-unused' } },
      ] } } : {}) }))
    scenario.version.definition.edges = [['entry', 'short'], ['entry', 'long1'], ['long1', 'long2'], ['long1', 'unused'],
      ['short', 'join'], ['long2', 'join'], ['unused', 'join']].map(([source, target]) => ({
      id: `${source}-${target}`, source: source!, target: target!, kind: 'execution' }))
    const entered = latch(), slow = latch(), fast = latch(), firstPair = latch()
    let firstPairCount = 0
    let active = 0, peak = 0
    const observed: string[] = []
    const fixture = graphHarness(scenario, {
      outcome: () => 'selected',
      beforeObserve: async (_execution, ref) => {
        const nodeId = ref.nodeId
        observed.push(nodeId); active++; peak = Math.max(peak, active)
        try {
          if (nodeId === 'short' || nodeId === 'long1') {
            if (++firstPairCount === 2) firstPair.release()
            await firstPair.promise
          }
          if (nodeId === 'short') await fast.promise
          if (nodeId === 'long2') { entered.release(); await slow.promise }
        } finally { active-- }
      },
    })
    let finished = false
    const invoking = fixture.run().then(() => { finished = true })
    await firstPair.promise
    expect(peak).toBe(2)
    fast.release()
    await entered.promise
    expect(finished).toBe(false)
    expect(observed).not.toContain('join')
    await expect.poll(() => fixture.outside.get('short')?.value.resolution).toBe('succeeded')
    expect(finished).toBe(false)
    slow.release()
    await invoking

    expect(peak).toBeLessThanOrEqual(2)
    expect(observed.filter((nodeId) => nodeId === 'join')).toHaveLength(1)
    expect(observed).not.toContain('unused')
    expect(fixture.outside.get('unused')?.value.resolution).toBe('skipped')
    const receiver = [...fixture.executions.values()].find((execution) => execution.workflowNodeId === 'join')!
    const bound = fixture.inputs.get(receiver.id)!
    const predecessors = bound.input.predecessors
    expect(predecessors.map((item) => item.relationshipId)).toEqual(['long2-join', 'short-join'])
    expect(predecessors.map((item) => item.execution.workflowNodeId)).toEqual(['long2', 'short'])
    const bindings = bound.bindings
    expect(bindings.map((item) => ['relationshipId' in item.source ? item.source.relationshipId : null, item.ordinal]))
      .toEqual([['long2-join', 0], ['short-join', 1]])
    for (const [index, item] of predecessors.entries()) {
      const sender = fixture.executions.get(item.execution.executionId)!
      expect(fixture.outside.get(sender.workflowNodeId)?.value.resolution).toBe('succeeded')
      expect(item.acceptedResult).toEqual(sender.result)
      expect(bindings[index]!.source.acceptedResultDigest).toBe(graphSourceDigest(sender.result))
      expect(bindings[index]!.inputDigest).toBe(graphSourceDigest(receiver.input))
    }
  })
})
