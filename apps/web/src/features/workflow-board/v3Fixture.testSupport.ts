import { WorkflowVersionV3Schema, WorkflowRunV3Schema, RepeatOccurrenceV1Schema, RepeatDecisionMetadataV1Schema, RepeatGraphCurrentV3Schema, RepeatGraphScopeV3Schema, RepeatGraphStateV3Schema, repeatGraphTopologyV3, type RepeatGraphStateV3 } from '@foreman-code/contracts/wave25'
import { currentWorkflowFixture as makeWave25Fixture } from '../../shared/mocks/currentWorkflow'

export const emptyBoardRepeatState = () => RepeatGraphStateV3Schema.parse({
  run: { executionState: 'queued', outcome: 'pending', stopRequested: false, cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
  nodes: [], inputBindings: [], interactions: [], reviews: [], occurrences: [], executions: [], resolutions: [], results: [], bindings: [], decisions: [],
})

/** Deterministic shared-schema read fixture, not a native/SQL qualification proof. */
export function boardV3Fixture(reason: 'early_exit' | 'limit_exit' | 'repeat' = 'limit_exit', runId = 'run-v3-history', versionId = 'version-v3-pinned') {
  const base = makeWave25Fixture(), [entry, exit] = base.version.definition.nodes
  const version = WorkflowVersionV3Schema.parse({ ...base.version, id: versionId, executionSemanticsVersion: 3,
    definition: { ...base.version.definition, executionSemanticsVersion: 3,
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 },
      nodes: [entry!, { ...exit!, choice: { outcomes: [
        { outcome: 'again', target: { kind: 'branch_end' } }, { outcome: 'done', target: { kind: 'branch_end' } },
      ] } }],
      repeat: { contractVersion: 1, blocks: [{ id: 'review', nodeIds: [entry!.id, exit!.id], entryNodeId: entry!.id,
        exitNodeId: exit!.id, maxOccurrences: reason === 'repeat' ? 2 : 1, repeatOutcome: 'again', earlyExitOutcome: 'done',
        limitExit: { kind: 'branch_end' } }] },
    },
  })
  const run = WorkflowRunV3Schema.parse({ ...base.run, id: runId, workflowVersionId: version.id, executionSemanticsVersion: 3,
    executionState: reason === 'repeat' ? 'running' : 'completed', outcome: reason === 'repeat' ? 'pending' : reason === 'early_exit' ? 'succeeded' : 'failed',
    ...(reason === 'repeat' ? {} : { finishedAt: '2026-09-24T10:00:00.000Z',
      result: reason === 'early_exit' ? { outcome: 'succeeded', output: { deliverable: 'Synthetic accepted deliverable', findings: [] } }
        : { outcome: 'failed', error: { code: 'REPEAT_LIMIT_REACHED', message: 'Synthetic finite limit', retryable: false } } }),
    agentConfigurationVersionIds: version.agentConfigurationVersionIds })
  const scope = RepeatGraphScopeV3Schema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
    runId: run.id, workflowVersionId: version.id, executionSemanticsVersion: 3 })
  const time = '2026-09-24T10:00:00.000Z', digest = `sha256:${'b'.repeat(64)}`, inputDigest = `sha256:${'a'.repeat(64)}`
  const occurrence = RepeatOccurrenceV1Schema.parse({ contractVersion: 1,
    identity: { scope, blockId: 'review', occurrenceId: `occ-${runId}`, occurrenceIndex: 1 },
    input: { bindingId: `binding-${runId}`, inputDigest, previous: null } })
  // Every technical predecessor is present, failed, and bound to the SAME input/occurrence.
  const executions: RepeatGraphStateV3['executions'] = [1, 2, 3, 4].map((attempt) => ({
    identity: { workflowNodeId: exit!.id, agentId: exit!.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[exit!.agentId]!, executionId: `execution-${runId}-${attempt}`,
      attempt, occurrence: occurrence.identity }, inputDigest,
    previousExecutionId: attempt === 1 ? null : `execution-${runId}-${attempt - 1}`,
    state: 'completed', resultOutcome: attempt === 4 ? 'succeeded' : 'failed',
  }))
  const execution = executions[3]!.identity
  const decision = RepeatDecisionMetadataV1Schema.parse({ contractVersion: 1, decisionId: `decision-${runId}`, occurrence,
    exitExecution: execution, acceptedResultDigest: digest, outcome: reason === 'early_exit' ? 'done' : 'again', reason,
    target: reason === 'repeat' ? { kind: 'next_occurrence', entryNodeId: entry!.id, occurrenceIndex: 2 } : { kind: 'branch_end' }, decidedAt: time })
  const state = RepeatGraphStateV3Schema.parse({ ...emptyBoardRepeatState(),
    run: { executionState: run.executionState, outcome: run.outcome, stopRequested: false, cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
    occurrences: [occurrence], decisions: [decision], executions, results: [{ execution, resultDigest: digest }] })
  const current = RepeatGraphCurrentV3Schema.parse({ protocolVersion: 1, kind: 'current', scope,
    topology: repeatGraphTopologyV3(version), state, asOfSequence: '3', retentionFloor: '0', historyCoverage: 'from_admission' })
  return { scope, version, run, current, occurrence, decision }
}
