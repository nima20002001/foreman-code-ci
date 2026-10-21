import { nativeNode, nativeDefinition } from '../../shared/mocks/nativeFixtureTypes'
import { AgentConfigurationVersionSchema, AgentSchema, type ExecutionResult } from '@foreman-code/contracts'
import {
  ExecutableWorkflowV3Schema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture,
  WorkflowRunV3Schema, CurrentRunDetailsSchema, RepeatGraphCurrentV3Schema,
  RunExecutionDetailSchema, RunExecutionBindingSchema, repeatGraphTopologyV3,
  type RunExecutionDetail, type RepeatOccurrenceV1,
} from '@foreman-code/contracts/wave25'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { inspectionScopeForRun, type RunInspectionFixture } from '../../shared/mocks/runInspection'
import { digestCurrentValue } from './runDetailsClient'

export const scenarioIds = ['S3-01', 'S3-02', 'S3-03', 'S3-04', 'S3-05-early', 'S3-05-limit'] as const
export type ScenarioId = typeof scenarioIds[number]
// ExecutionResult is one object with an outcome enum, not a discriminated union.
export type SuccessfulResult = ExecutionResult & { outcome: 'succeeded' }
export type Scenario = ReturnType<typeof scenarioFixture>

/** Declarative S3-only shapes mirrored in the API scenario table. This module
 * contains no API imports. The Board fixture below is MSW contract evidence,
 * never a claim of PostgreSQL execution, native work or receipt qualification. */
export function scenarioFixture(id: ScenarioId, suffix: string) {
  const repeat = id.startsWith('S3-05')
  const source = makeCurrentWorkflowFixture(suffix, repeat ? 'repeat' : 'sequential')
  const count = id === 'S3-02' ? 4 : id === 'S3-03' ? 6 : id === 'S3-04' ? 3 : 2
  while (source.configurations.length < count) {
    const index = source.configurations.length
    source.configurations.push(AgentConfigurationVersionSchema.parse({ ...source.configurations[0],
      id: `cfg-${suffix}-${index}`, agentId: `agent-${suffix}-${index}` }))
  }
  const nodes: ReturnType<typeof nativeDefinition>['nodes'] = source.configurations.map((configuration, index) => ({
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
  const parsedVersion = WorkflowVersionV3Schema.parse({ ...source.version,
    agentConfigurationVersionIds: Object.fromEntries(source.configurations.map((configuration) => [configuration.agentId, configuration.id])),
    definition: { ...source.version.definition, name: id, nodes, edges,
      executionPolicy: { maxParallelism: id === 'S3-02' || id === 'S3-03' ? 2 : 1,
        maxNodeExecutions: repeat ? 6 : count } },
  })
  source.version={...parsedVersion,definition:nativeDefinition(parsedVersion.definition)}
  source.run.agentConfigurationVersionIds = { ...source.version.agentConfigurationVersionIds }
  source.identities = nodes.map((node, index) => ({ workflowNodeId: node.id, executionId: `exec-${suffix}-${index}`,
    agentId: nativeNode(node).agentId, agentConfigurationVersionId: source.version.agentConfigurationVersionIds[nativeNode(node).agentId]!, attempt: 1 }))
  ExecutableWorkflowV3Schema.parse({ version: source.version, configurations: source.configurations })
  const occurrences = repeat ? id === 'S3-05-early' ? 2 : 3 : 1
  const executedIndexes = Array.from({ length: count }, (_, index) => index).filter((index) => id !== 'S3-03' || index !== 4)
  const predecessors = pairs.filter(([from, to]) => executedIndexes.includes(from!) && executedIndexes.includes(to!))
  const result = (nodeIndex: number, occurrenceIndex = 1): SuccessfulResult => {
    if (!executedIndexes.includes(nodeIndex) || occurrenceIndex < 1 || occurrenceIndex > occurrences) {
      throw new Error(`Unexpected ${id} provider execution: node=${nodeIndex}, occurrence=${occurrenceIndex}`)
    }
    const data = { marker: `${id}:${nodeIndex}:${occurrenceIndex}`, unicode: 'exact-λ', nested: { zero: 0, no: false, empty: '' } }
    return { outcome: 'succeeded', output: id === 'S3-03' && nodeIndex === 2
      ? { text: JSON.stringify({ routing: { outcome: 'long' }, data }) }
      : repeat && nodeIndex === 1 ? { text: JSON.stringify({
        routing: { outcome: id === 'S3-05-early' && occurrenceIndex === occurrences ? 'pass' : 'issues' },
        data: { latestDeliverable: data, remainingFindings: id === 'S3-05-early' && occurrenceIndex === occurrences ? [] : [{ id: `finding-${occurrenceIndex}` }] },
      }) } : data }
  }
  return { id, source, nodes, edges, repeat, occurrences, executedIndexes, predecessors, result,
    approvalNodeIds: id === 'S3-04' ? [nodes[1]!.id] : [],
    slowNodeId: id === 'S3-02' ? nodes[2]!.id : id === 'S3-03' ? nodes[3]!.id : undefined,
    joinNodeId: id === 'S3-02' ? nodes[3]!.id : id === 'S3-03' ? nodes[5]!.id : undefined,
    runInput: { instruction: `ENG07 ${id}: preserve exact accepted inputs`, payload: { zero: 0, no: false, unicode: 'λ', empty: '' } },
  }
}


export async function eng07BoardFixture(id: ScenarioId, suffix: string) {
  const scenario = scenarioFixture(id, suffix), { source } = scenario, version = source.version
  const agents = source.configurations.map((config, index) => AgentSchema.parse({ id: config.agentId,
    name: `Current directory name ${index}`, productRole: config.productRole, harness: config.harness.harness,
    harnessConfiguration: config.harness, configurationVersionId: config.id, prompt: config.prompt, assignedSkills: config.assignedSkills }))
  const mock = createCurrentBoardMock({ workspaceId: source.scope.workspaceId, agents, initialWorkflow: version.definition })
  mock.versions.clear(); mock.versions.set(version.id, version)
  mock.workflows.set(version.workflowId, version.definition)
  const draft = mock.drafts.get(version.workflowId)!
  mock.drafts.set(version.workflowId, { ...draft, graph: version.definition, baseWorkflowVersionId: version.id })
  const run = WorkflowRunV3Schema.parse({ ...source.run, agentConfigurationVersionIds: version.agentConfigurationVersionIds,
    input: scenario.runInput, executionState: 'completed', outcome: 'succeeded', startedAt: source.createdAt, finishedAt: source.createdAt,
    result: scenario.result(scenario.executedIndexes.at(-1)!, scenario.occurrences) })
  const record = CurrentRunDetailsSchema.parse({ run, executions: [], activity: [], cleanupPending: false })
  const scope = inspectionScopeForRun(record), rows: RunInspectionFixture[] = []
  const at = (index: number, round: number) => rows.find((row) => row.detail.execution.workflowNodeId === nativeNode(scenario.nodes[index]!).id
    && (row.detail.execution.occurrence?.occurrenceIndex ?? 1) === round)!
  for (let round = 1; round <= scenario.occurrences; round++) {
    const previous = scenario.repeat && round > 1 ? at(1, round - 1).detail : undefined
    const carry = previous ? { decisionId: `decision-${run.id}-${round - 1}`,
      execution: { workflowNodeId: previous.execution.workflowNodeId, executionId: previous.execution.executionId,
        agentId: nativeNode(previous.execution).agentId, agentConfigurationVersionId: nativeNode(previous.execution).agentConfigurationVersionId,
        attempt: 1, occurrence: previous.execution.occurrence! },
      acceptedResult: scenario.result(1, round - 1), acceptedResultDigest: await digestCurrentValue(scenario.result(1, round - 1)) } : null
    const entry = { runInput: run.input, external: [], carry }
    const occurrence: RepeatOccurrenceV1 | null = scenario.repeat ? { contractVersion: 1,
      identity: { scope, blockId: 'repair', occurrenceId: `occ-${run.id}-${round}`, occurrenceIndex: round },
      input: { bindingId: `entry-${run.id}-${round}`, inputDigest: await digestCurrentValue(entry),
        previous: previous ? { occurrenceId: previous.execution.occurrence!.occurrenceId, occurrenceIndex: round - 1,
          decisionId: carry!.decisionId, acceptedResultDigest: carry!.acceptedResultDigest } : null } } : null
    for (const index of scenario.executedIndexes) {
      const node = nativeNode(scenario.nodes[index]!), executionId = `exec-${run.id}-${index}-${round}`
      const identity = { executionId, workflowNodeId: node.id, agentId: nativeNode(node).agentId,
        agentConfigurationVersionId: version.agentConfigurationVersionIds[nativeNode(node).agentId]!, attempt: 1 }
      const predecessors: Array<RunExecutionDetail['acceptedInput']['value']['predecessors'][number]> = []
      for (const edge of scenario.edges.filter((edge) => edge.target === node.id).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
        const from = scenario.nodes.findIndex((candidate) => candidate.id === edge.source)
        if (!scenario.executedIndexes.includes(from)) continue
        const sender = at(from, round).detail.execution, result = scenario.result(from, round)
        predecessors.push({ relationshipId: edge.id, execution: { executionId: sender.executionId,
          workflowNodeId: sender.workflowNodeId, agentId: nativeNode(sender).agentId,
          agentConfigurationVersionId: nativeNode(sender).agentConfigurationVersionId, attempt: 1 },
          occurrence: occurrence?.identity ?? null, acceptedResult: result, acceptedResultDigest: await digestCurrentValue(result) })
      }
      const value: RunExecutionDetail['acceptedInput']['value'] = { executionSemanticsVersion: 3,
        runInput: run.input, occurrence, entry: scenario.repeat && index === 0 ? entry : null, predecessors }
      const result = scenario.result(index, round), inputDigest = await digestCurrentValue(value)
      const detail = RunExecutionDetailSchema.parse({ run: { ...scope, executionState: 'completed', outcome: 'succeeded',
        createdAt: source.createdAt, startedAt: source.createdAt, finishedAt: source.createdAt, cleanupPending: false },
        execution: { ...identity, ...(occurrence ? { occurrence: occurrence.identity } : {}), state: 'completed',
          createdAt: source.createdAt, startedAt: source.createdAt, finishedAt: source.createdAt, acceptedResultAvailable: true },
        acceptedInput: { digest: inputDigest, value }, reportedResult: result,
        acceptedResult: { status: 'accepted', digest: await digestCurrentValue(result), value: result } })
      const bindings = predecessors.map((input, ordinal) => RunExecutionBindingSchema.parse({
        bindingId: `binding-${executionId}-${ordinal}`, kind: 'predecessor', recipient: identity,
        recipientOccurrence: occurrence?.identity ?? null, inputDigest, ordinal, source: input }))
      if (value.entry?.carry) bindings.push(RunExecutionBindingSchema.parse({ bindingId: `carry-${executionId}`,
        kind: 'carry', recipient: identity, recipientOccurrence: occurrence!.identity, inputDigest,
        ordinal: bindings.length, source: value.entry.carry }))
      rows.push({ detail, bindings })
    }
  }
  mock.runs.clear(); mock.currents.clear()
  mock.runs.set(run.id, record); mock.inspection.set(run.id, rows)
  // A compact current cut need not carry full execution history. The real Board
  // must obtain exact rows through its bounded private inspection HTTP clients.
  mock.currents.set(run.id, RepeatGraphCurrentV3Schema.parse({ kind: 'current', protocolVersion: 1, scope,
    topology: repeatGraphTopologyV3(version), asOfSequence: '0', retentionFloor: '0', historyCoverage: 'from_admission',
    state: { run: { executionState: 'completed', outcome: 'succeeded', cleanupPending: false, stopRequested: false,
      pendingInteractionCount: 0, unsettledReviewCount: 0 }, nodes: [], inputBindings: [], interactions: [], reviews: [],
      occurrences: [], executions: [], resolutions: [], results: [], bindings: [], decisions: [] } }))
  return { scenario, mock, scope, version, run, rows, record, at }
}
