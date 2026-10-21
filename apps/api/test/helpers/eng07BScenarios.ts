import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { AgentConfigurationVersionSchema, type ExecutionResult } from '@foreman-code/contracts'
import {
  ExecutableWorkflowV3Schema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'

export const scenarioIds = ['S3-01', 'S3-02', 'S3-03', 'S3-04', 'S3-05-early', 'S3-05-limit'] as const
export type ScenarioId = typeof scenarioIds[number]
// ExecutionResult is one object with an outcome enum, not a discriminated union.
export type SuccessfulResult = ExecutionResult & { outcome: 'succeeded' }
export type Scenario = ReturnType<typeof scenarioFixture>

/** S3-only topology and an independent expected-result oracle. No Run state,
 * result, native proof, closure, or acceptance row is written by this fixture. */
export function scenarioFixture(id: ScenarioId, suffix: string) {
  const repeat = id.startsWith('S3-05')
  const source = makeCurrentWorkflowFixture(suffix, repeat ? 'repeat' : 'sequential')
  const count = id === 'S3-02' ? 4 : id === 'S3-03' ? 6 : id === 'S3-04' ? 3 : 2
  while (source.configurations.length < count) {
    const index = source.configurations.length
    source.configurations.push(AgentConfigurationVersionSchema.parse({ ...source.configurations[0],
      id: `cfg-${suffix}-${index}`, agentId: `agent-${suffix}-${index}` }))
  }
  const nodes: ReturnType<typeof agentWorkflowVersion>['definition']['nodes'] = source.configurations.map((configuration, index) => ({
    id: `node-${suffix}-${index}`, agentId: configuration.agentId, name: `${id} Worker ${index}`,
  }))
  const pairs = id === 'S3-02' ? [[0, 1], [0, 2], [1, 3], [2, 3]]
    // Fast reaches Join directly. Router chooses Slow, leaving Other inactive.
    // Join must wait for Slow and must not wait forever for Other.
    : id === 'S3-03' ? [[0, 1], [0, 2], [2, 3], [2, 4], [1, 5], [3, 5], [4, 5]]
      : id === 'S3-04' ? [[0, 1], [1, 2]] : [[0, 1]]
  const edges = pairs.map(([from, to], index) => ({ id: `edge-${suffix}-${index}`, kind: 'execution' as const,
    source: nodes[from!]!.id, target: nodes[to!]!.id }))
  if (id === 'S3-02') nodes[3]!.join = { mode: 'all' }
  if (id === 'S3-03') {
    nodes[5]!.join = { mode: 'all' }
    nodes[2]!.choice = { outcomes: [
      { outcome: 'long', target: { kind: 'edge', relationshipId: edges[2]!.id } },
      { outcome: 'other', target: { kind: 'edge', relationshipId: edges[3]!.id } },
    ] }
  }
  if (repeat) nodes[1]!.choice = { outcomes: [
    { outcome: 'issues', target: { kind: 'branch_end' } },
    { outcome: 'pass', target: { kind: 'branch_end' } },
  ] }
  source.version = agentWorkflowVersion(WorkflowVersionV3Schema.parse({ ...source.version,
    agentConfigurationVersionIds: Object.fromEntries(source.configurations.map((configuration) => [configuration.agentId, configuration.id])),
    definition: { ...source.version.definition, name: id, nodes, edges,
      executionPolicy: { maxParallelism: id === 'S3-02' || id === 'S3-03' ? 2 : 1,
        maxNodeExecutions: repeat ? 6 : count } },
  }))
  source.run.agentConfigurationVersionIds = { ...source.version.agentConfigurationVersionIds }
  source.identities = nodes.map((node, index) => ({ workflowNodeId: node.id, executionId: `exec-${suffix}-${index}`,
    agentId: node.agentId, agentConfigurationVersionId: source.version.agentConfigurationVersionIds[node.agentId]!, attempt: 1 }))
  ExecutableWorkflowV3Schema.parse({ version: source.version, configurations: source.configurations })
  const occurrences = repeat ? id === 'S3-05-early' ? 2 : 3 : 1
  const executedIndexes = Array.from({ length: count }, (_, index) => index).filter((index) => id !== 'S3-03' || index !== 4)
  const predecessors = pairs.filter(([from, to]) => executedIndexes.includes(from!) && executedIndexes.includes(to!))
  const result = (nodeIndex: number, occurrenceIndex = 1): SuccessfulResult => {
    if (!executedIndexes.includes(nodeIndex) || occurrenceIndex < 1 || occurrenceIndex > occurrences) {
      throw new Error(`Unexpected ${id} provider execution: node=${nodeIndex}, occurrence=${occurrenceIndex}`)
    }
    const data = { marker: `${id}:${nodeIndex}:${occurrenceIndex}`, unicode: 'exact-λ', nested: { zero: 0, no: false, empty: '' } }
    const fields = { summary: 'Completed the assigned work.', board: { kind: 'none', reason: 'no_access' } }
    if (id === 'S3-03' && nodeIndex === 2) {
      return { outcome: 'succeeded', output: { text: JSON.stringify({ routing: { outcome: 'long' }, data, ...fields }) } }
    }
    if (repeat && nodeIndex === 1) {
      return { outcome: 'succeeded', output: { text: JSON.stringify({
        routing: { outcome: id === 'S3-05-early' && occurrenceIndex === occurrences ? 'pass' : 'issues' },
        data: { latestDeliverable: data, remainingFindings: id === 'S3-05-early' && occurrenceIndex === occurrences ? [] : [{ id: `finding-${occurrenceIndex}` }] },
        ...fields,
      }) } }
    }
    return { outcome: 'succeeded', output: { data, ...fields } }
  }
  return { id, source, nodes, edges, repeat, occurrences, executedIndexes, predecessors, result,
    approvalNodeIds: id === 'S3-04' ? [nodes[1]!.id] : [],
    slowNodeId: id === 'S3-02' ? nodes[2]!.id : id === 'S3-03' ? nodes[3]!.id : undefined,
    joinNodeId: id === 'S3-02' ? nodes[3]!.id : id === 'S3-03' ? nodes[5]!.id : undefined,
    runInput: { instruction: `ENG07 ${id}: preserve exact accepted inputs`, payload: { zero: 0, no: false, unicode: 'λ', empty: '' } },
  }
}
