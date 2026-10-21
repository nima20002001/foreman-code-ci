import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { AgentSchema, RunActivitySchema } from '@foreman-code/contracts'
import {
  CurrentRunDetailsSchema, RunExecutionBindingSchema, RunExecutionDetailSchema,
  WorkflowVersionV3Schema, WorkflowRunV3Schema, RepeatGraphCurrentV3Schema, repeatGraphTopologyV3,
  makeCurrentWorkflowFixture, type WorkflowVersionV3, type RunExecutionDetail,
} from '@foreman-code/contracts/wave25'
import { createCurrentBoardMock } from '../../../shared/mocks/currentBoard'
import { inspectionScopeForRun, type RunInspectionFixture } from '../../../shared/mocks/runInspection'
import { digestCurrentValue } from '../runDetailsClient'

/** Contract/MSW fixtures only. No native provider, SQL or acceptance receipt is
 * simulated as production evidence. The compact current cut is intentionally
 * empty: recorded executions must come from the authenticated history endpoints. */
export async function inspectionBoardFixture(suffix = 'inspect', firstNodeId?: string) {
  const source = makeCurrentWorkflowFixture(suffix, 'repeat')
  if (firstNodeId) {
    const original = source.version.definition.nodes[0]!.id
    source.version.definition.nodes[0]!.id = firstNodeId
    source.version.definition.entryNodeId = firstNodeId
    source.version.entryNodeId = firstNodeId
    if (source.version.definition.repeat) {
      source.version.definition.repeat.blocks = source.version.definition.repeat.blocks.map(block => ({ ...block,
        nodeIds: block.nodeIds.map(id => id === original ? firstNodeId : id),
        entryNodeId: block.entryNodeId === original ? firstNodeId : block.entryNodeId,
        exitNodeId: block.exitNodeId === original ? firstNodeId : block.exitNodeId }))
    }
    source.version.definition.edges = source.version.definition.edges.map(edge => ({ ...edge,
      source: edge.source === original ? firstNodeId : edge.source,
      target: edge.target === original ? firstNodeId : edge.target }))
  }
  const first = nativeNode(source.version.definition.nodes[0]!), second = nativeNode(source.version.definition.nodes[1]!)
  const { repeat: _repeat, ...ordinary } = source.version.definition
  void _repeat
  const before = WorkflowVersionV3Schema.parse({ ...source.version, id: `version-${suffix}-before`, version: 1,
    agentConfigurationVersionIds: { [first.agentId]: source.version.agentConfigurationVersionIds[first.agentId] },
    definition: { ...ordinary, name: 'Before repeat', version: 1, nodes: [first], edges: [],
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 200 } } })
  const repeated = WorkflowVersionV3Schema.parse({ ...source.version, id: `version-${suffix}-repeat`, version: 2,
    definition: { ...source.version.definition, name: 'With repeat', version: 2 } })
  const added = { id: `node-${suffix}-added-later`, name: 'Added later', agentId: second.agentId }
  const after = WorkflowVersionV3Schema.parse({ ...source.version, id: `version-${suffix}-after`, version: 3,
    definition: { ...ordinary, name: 'After repeat removed', version: 3, nodes: [first, added],
      edges: [{ id: `edge-${suffix}-after`, source: first.id, target: added.id, kind: 'execution' }] } })
  const agents = source.configurations.map((config, i) => AgentSchema.parse({
    id: config.agentId, name: `Current Agent name ${i}`, productRole: config.productRole,
    harness: config.harness.harness, harnessConfiguration: config.harness, configurationVersionId: config.id,
    prompt: config.prompt, assignedSkills: config.assignedSkills,
  }))
  const mock = createCurrentBoardMock({ workspaceId: source.scope.workspaceId, agents, initialWorkflow: after.definition })
  mock.versions.clear()
  for (const version of [before, repeated, after]) mock.versions.set(version.id, version)
  mock.workflows.set(source.scope.workflowId, after.definition)
  const draft = mock.drafts.get(source.scope.workflowId)!
  mock.drafts.set(source.scope.workflowId, { ...draft, graph: after.definition, baseWorkflowVersionId: after.id })
  function install(version: WorkflowVersionV3, label: string) {
    const run = WorkflowRunV3Schema.parse({ ...source.run, id: `run-${suffix}-${label}`, workflowVersionId: version.id,
      agentConfigurationVersionIds: version.agentConfigurationVersionIds,
      executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded', output: { label } },
      startedAt: source.createdAt, finishedAt: source.createdAt })
    const detail = CurrentRunDetailsSchema.parse({ run, executions: [], activity: [], cleanupPending: false })
    const scope = inspectionScopeForRun(detail)
    mock.runs.set(run.id, detail)
    mock.currents.set(run.id, RepeatGraphCurrentV3Schema.parse({
      kind: 'current', protocolVersion: 1, scope, topology: repeatGraphTopologyV3(version), asOfSequence: '0',
      retentionFloor: '0', historyCoverage: 'from_admission',
      state: { run: { executionState: 'completed', outcome: 'succeeded', stopRequested: false,
        cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
        nodes: [], inputBindings: [], interactions: [], reviews: [], occurrences: [], executions: [],
        resolutions: [], results: [], bindings: [], decisions: [] },
    }))
    return { run, scope, version }
  }
  const runs = { before: install(before, 'before'), repeated: install(repeated, 'repeat'), after: install(after, 'after') }
  async function execution(owner: typeof runs.before, index: number, repetition?: number, attempt = 1): Promise<RunInspectionFixture> {
    const node = nativeNode(owner.version.definition.nodes[index]!)
    const identity = { workflowNodeId: node.id, executionId: `exec-${owner.run.id}-${index}-${repetition ?? 'ordinary'}-${attempt}`,
      agentId: nativeNode(node).agentId, agentConfigurationVersionId: owner.version.agentConfigurationVersionIds[nativeNode(node).agentId]!, attempt }
    const occurrence = repetition === undefined ? undefined : { scope: owner.scope, blockId: 'repair',
      occurrenceId: `occ-${owner.run.id}-${repetition}`, occurrenceIndex: repetition }
    const value: RunExecutionDetail['acceptedInput']['value'] = {
      executionSemanticsVersion: 3, runInput: owner.run.input,
      occurrence: occurrence ? { contractVersion: 1, identity: occurrence, input: {
        bindingId: `entry-${occurrence.occurrenceId}`, inputDigest: `sha256:${'1'.repeat(64)}`,
        previous: repetition === 1 ? null : { occurrenceId: `occ-${owner.run.id}-${repetition! - 1}`, occurrenceIndex: repetition! - 1,
          decisionId: `decision-${owner.run.id}-${repetition! - 1}`, acceptedResultDigest: `sha256:${'2'.repeat(64)}` },
      } } : null,
      entry: null, predecessors: [],
    }
    // The non-entry step consumes its exact predecessor in the same occurrence.
    if (index > 0) {
      const senderNode = nativeNode(owner.version.definition.nodes[0]!)
      const result = { outcome: 'succeeded' as const, output: { text: `Exact predecessor of ${identity.executionId}` } }
      value.predecessors.push({
        relationshipId: owner.version.definition.edges.find((edge) => edge.target === node.id)!.id,
        execution: { workflowNodeId: senderNode.id, executionId: `sender-${identity.executionId}`, agentId: senderNode.agentId,
          agentConfigurationVersionId: owner.version.agentConfigurationVersionIds[senderNode.agentId]!, attempt: 1 },
        occurrence: occurrence ?? null, acceptedResult: result, acceptedResultDigest: await digestCurrentValue(result),
      })
    }
    const text = `Exact accepted output ${identity.executionId}`
    const result = { outcome: 'succeeded' as const, output: { text: repetition === undefined ? text
      : JSON.stringify({ outcome: repetition === 3 ? 'pass' : 'issues',
        data: { latestDeliverable: { text }, remainingFindings: repetition === 3 ? [] : ['Another pass'] } }) } }
    const detail = RunExecutionDetailSchema.parse({
      run: { ...owner.scope, executionState: owner.run.executionState, outcome: owner.run.outcome,
        createdAt: source.createdAt, startedAt: source.createdAt, finishedAt: source.createdAt, cleanupPending: false },
      execution: { ...identity, ...(occurrence ? { occurrence } : {}), state: 'completed',
        createdAt: source.createdAt, startedAt: source.createdAt, finishedAt: source.createdAt, acceptedResultAvailable: true },
      acceptedInput: { digest: await digestCurrentValue(value), value },
      acceptedResult: { status: 'accepted', digest: await digestCurrentValue(result), value: result },
    })
    const bindings = value.predecessors.map((input, ordinal) => RunExecutionBindingSchema.parse({
      bindingId: `binding-${identity.executionId}-${ordinal}`, kind: 'predecessor', recipient: identity,
      recipientOccurrence: occurrence ?? null, inputDigest: detail.acceptedInput.digest, ordinal, source: input,
    }))
    return { detail, bindings }
  }
  const ordinaryExecutions = [await execution(runs.before, 0), await execution(runs.before, 0, undefined, 2)]
  const repeatedExecutions = [await execution(runs.repeated, 1, 1), await execution(runs.repeated, 1, 2),
    await execution(runs.repeated, 1, 2, 2), await execution(runs.repeated, 1, 3)]
  // Failed native attempts are not accepted results, nor extra business rounds.
  for (const attempt of [ordinaryExecutions[0]!, repeatedExecutions[1]!]) {
    attempt.detail = RunExecutionDetailSchema.parse({ ...attempt.detail,
      execution: { ...attempt.detail.execution, acceptedResultAvailable: false },
      acceptedResult: { status: 'not_accepted' },
      reportedResult: { outcome: 'failed', error: { code: 'FIXTURE_INTERRUPTED', message: 'Technical retry fixture', retryable: true } } })
  }
  mock.inspection.set(runs.before.run.id, ordinaryExecutions)
  mock.inspection.set(runs.repeated.run.id, repeatedExecutions)
  mock.inspection.set(runs.after.run.id, [await execution(runs.after, 1)])
  mock.history.set(runs.repeated.run.id, Array.from({ length: 52 }, (_, sequence) => RunActivitySchema.parse({
    id: `activity-${suffix}-${sequence}`, runId: runs.repeated.run.id, sequence, source: 'backend',
    kind: 'result_recorded', occurredAt: source.createdAt, payload: { text: `Historical event ${sequence}` },
  })))
  return { mock, runs, before, repeated, after, first, second, added, ordinaryExecutions, repeatedExecutions, execution }
}
