import { describe, expect, it } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL, parseCoordinationResult } from '@foreman-code/contracts'
import { ExecutableWorkflowV3Schema, parseRepeatExitResultV1 } from '@foreman-code/contracts/wave25'
import { scenarioFixture, scenarioIds } from './helpers/eng07BScenarios.js'

describe('workflow scenario fixture integrity (no PostgreSQL required)', () => {
  it.each(scenarioIds)('%s pins every node/configuration and uses the one V3 contract', (id) => {
    const f = scenarioFixture(id, `fixture-${id}`)
    expect(ExecutableWorkflowV3Schema.parse({ version: f.source.version, configurations: f.source.configurations }).version)
      .toEqual(f.source.version)
    expect(f.source.run.agentConfigurationVersionIds).toEqual(f.source.version.agentConfigurationVersionIds)
    expect(f.source.identities.map((item) => item.workflowNodeId)).toEqual(f.nodes.map((node) => node.id))
    expect(Object.keys(f.source.version.agentConfigurationVersionIds)).toHaveLength(f.nodes.length)
    expect(f.source.version.executionSemanticsVersion).toBe(3)
    expect(f.source.version.definition.executionSemanticsVersion).toBe(3)
    expect(f.source.run.executionSemanticsVersion).toBe(3)
    expect(Object.hasOwn(f.source.version.definition, 'repeat')).toBe(f.repeat)
    expect(f.source.run).not.toHaveProperty('repeat')
    for (const round of Array.from({ length: f.occurrences }, (_, index) => index + 1)) {
      for (const node of f.executedIndexes) {
        const result = f.result(node, round)
        expect(result.outcome).toBe('succeeded')
        const parsed = parseCoordinationResult(result.output, { resultProtocol: COORDINATION_RESULT_PROTOCOL,
          definition: f.source.version.definition, workflowNodeId: f.nodes[node]!.id })
        expect(parsed.summary).toBe('Completed the assigned work.')
        expect(parsed.board).toEqual({ kind: 'none', reason: 'no_access' })
      }
    }
    expect(() => f.result(f.executedIndexes[0]!, f.occurrences + 1)).toThrow('Unexpected')
    if (f.repeat) {
      const block = f.source.version.definition.repeat!.blocks[0]!
      expect(block.maxOccurrences).toBe(3)
      expect(f.source.version.definition.executionPolicy!.maxNodeExecutions).toBe(6)
      const final = parseRepeatExitResultV1(f.result(1, f.occurrences), f.nodes[1]!.choice!, undefined,
        { resultProtocol: COORDINATION_RESULT_PROTOCOL, definition: f.source.version.definition,
          workflowNodeId: f.nodes[1]!.id })
      expect(final.routing.outcome).toBe(id === 'S3-05-early' ? 'pass' : 'issues')
      expect(final.data.remainingFindings).toEqual(id === 'S3-05-early' ? [] : [{ id: 'finding-3' }])
    }
    if (id === 'S3-03') {
      expect(f.nodes).toHaveLength(6)
      expect(f.executedIndexes).toEqual([0, 1, 2, 3, 5])
      expect(f.predecessors.filter(([, to]) => to === 5)).toEqual([[1, 5], [3, 5]])
      expect(() => f.result(4)).toThrow('Unexpected')
    }
    if (id === 'S3-04') {
      expect(f.source.version.approval).toEqual({ handler: 'user' })
      expect(f.approvalNodeIds).toEqual([f.nodes[1]!.id])
    }
  })
})
