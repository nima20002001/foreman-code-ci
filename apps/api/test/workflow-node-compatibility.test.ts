import { describe, expect, it } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import {
  WorkflowVersionV3Schema, makeCurrentWorkflowFixture, validateRepeatDecisionV1,
  type GraphExecutionIdentity, type RepeatDecisionV1, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import { publicNodeState } from '../src/modules/run-graph/publicLifecycle.js'
import type { CurrentNativeActivity } from '../src/modules/run-graph/nativeActivitySelection.js'
import {
  assertRepeatExecution, assertRepeatSource, bindRepeatNodeInput, compileRepeatLayout,
  decideRepeatExit, finalRepeatExport, freezeRepeatEntry, makeRepeatOccurrence,
  repeatDigest, repeatExecutionIdentity, type RepeatResolution,
} from '../src/modules/runs/repeatResolution.js'
import { hasSupportedApprovalTopology, resolveImmutableApprovalRoute } from '../src/modules/workflows/approvalRoutes.js'

function jobNode(id: string) {
  return { kind: 'job' as const, id, name: id, jobDefinitionId: 'job-definition',
    jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version' }
}
function repeated() {
  const f = makeCurrentWorkflowFixture('node-compat-repeat', 'repeat')
  const version: WorkflowVersionV3 = structuredClone(f.version)
  const block = version.definition.repeat!.blocks[0]!
  const entry = freezeRepeatEntry({}, [])
  const { occurrence } = makeRepeatOccurrence(f.scope, block, entry, null)
  const execution: HarnessExecution = { id: 'exit-execution', runId: f.run.id,
    workflowNodeId: block.exitNodeId, agentId: f.identities[1]!.agentId,
    agentConfigurationVersionId: f.identities[1]!.agentConfigurationVersionId, attempt: 1,
    input: {}, state: 'completed', result: { outcome: 'succeeded', output: {
      routing: { outcome: 'pass' }, data: { latestDeliverable: {}, remainingFindings: [] } } },
    createdAt: f.createdAt, finishedAt: f.createdAt }
  return { ...f, version, block, entry, occurrence, execution }
}

describe('current mixed Agent/Job node boundaries', () => {
  it('resolves the exact Agent approval route alongside multiple Job execution nodes', () => {
    const f = makeCurrentWorkflowFixture('node-compat-approval', 'approval')
    const version: WorkflowVersionV3 = structuredClone(f.version)
    version.definition.nodes.push(jobNode('build'), jobNode('publish'))
    version.definition.edges.push(
      { id: 'build-edge', kind: 'execution', source: f.identities[1]!.workflowNodeId, target: 'build' },
      { id: 'publish-edge', kind: 'execution', source: 'build', target: 'publish' },
    )
    version.definition.executionPolicy!.maxNodeExecutions = 4
    expect(WorkflowVersionV3Schema.safeParse(version).success).toBe(true)
    const before = structuredClone(version)
    expect(hasSupportedApprovalTopology(version)).toBe(true)
    expect(resolveImmutableApprovalRoute(version, f.identities[1]!.workflowNodeId, f.identities[1]!.agentId))
      .toMatchObject({ requestingConfigurationVersionId: f.identities[1]!.agentConfigurationVersionId,
        reviewerConfigurationVersionId: f.identities[0]!.agentConfigurationVersionId, relationshipId: 'review-node-compat-approval' })
    expect(resolveImmutableApprovalRoute(version, 'build', f.identities[1]!.agentId)).toBeUndefined()
    expect(version).toEqual(before)
  })
  it.each(['requester', 'reviewer', 'extra-assignment'])('refuses a Job %s in native approval topology', (role) => {
    const f = makeCurrentWorkflowFixture('node-compat-denial', 'approval')
    const version: WorkflowVersionV3 = structuredClone(f.version)
    if (role === 'extra-assignment') {
      version.definition.nodes.push(jobNode('build'))
      version.definition.edges.push({ id: 'job-approval', kind: 'approval', source: version.entryNodeId, target: 'build' })
    } else {
      const index = role === 'reviewer' ? 0 : 1
      version.definition.nodes[index] = jobNode(f.identities[index]!.workflowNodeId)
    }
    expect(hasSupportedApprovalTopology(version)).toBe(false)
    expect(resolveImmutableApprovalRoute(version, f.identities[1]!.workflowNodeId, f.identities[1]!.agentId)).toBeUndefined()
  })
  it('allows distinct Worker nodes to reuse an Agent in a mixed graph', () => {
    const f = makeCurrentWorkflowFixture('node-compat-duplicate', 'approval')
    const version: WorkflowVersionV3 = structuredClone(f.version)
    version.definition.nodes.push(jobNode('build'), { ...f.version.definition.nodes[1]!, id: 'duplicate-agent' })
    expect(hasSupportedApprovalTopology(version)).toBe(true)
    expect(resolveImmutableApprovalRoute(version, f.identities[1]!.workflowNodeId, f.identities[1]!.agentId))
      .toMatchObject({ requestingNodeId: f.identities[1]!.workflowNodeId })
    expect(resolveImmutableApprovalRoute(version, 'duplicate-agent', f.identities[1]!.agentId)).toBeUndefined()
    version.definition.nodes.push({ ...f.version.definition.nodes[0]!, id: 'duplicate-reviewer' })
    expect(resolveImmutableApprovalRoute(version, f.identities[1]!.workflowNodeId, f.identities[1]!.agentId)).toBeUndefined()
  })
  it('never promotes a Job from a colliding Agent native acknowledgement', () => {
    const f = makeCurrentWorkflowFixture('node-compat-lifecycle', 'single'), agent = f.identities[0]!
    const job: GraphExecutionIdentity = { kind: 'job', workflowNodeId: agent.workflowNodeId,
      executionId: agent.executionId, attempt: agent.attempt, jobDefinitionId: 'job-definition', jobDefinitionVersionId: 'job-version' }
    const native: CurrentNativeActivity = { key: { execution: agent, workKind: 'workflow', workId: agent.executionId },
      activity: { workflowNodeId: agent.workflowNodeId, execution: agent, status: 'active', action: 'working',
        acknowledgementId: 'ack', correlationId: 'correlation' }, lastNativeSequence: '1' }
    expect(publicNodeState(agent.workflowNodeId, { execution: agent, state: 'running' }, undefined, [native]).lifecycle).toBe('running')
    expect(publicNodeState(job.workflowNodeId, { execution: job, state: 'running' }, undefined, [native])).toEqual({
      workflowNodeId: job.workflowNodeId, execution: job, lifecycle: 'starting' })
    expect(publicNodeState(agent.workflowNodeId, { execution: agent, state: 'running' }, undefined,
      [{ ...native, activity: { ...native.activity, execution: job } }]).lifecycle).toBe('starting')
    expect(publicNodeState(job.workflowNodeId, { execution: job, state: 'queued' }, undefined, [native]).lifecycle).toBe('queued')
    expect(publicNodeState(job.workflowNodeId, { execution: job, state: 'completed', outcome: 'failed' }, undefined, [native])).toEqual({
      workflowNodeId: job.workflowNodeId, execution: job, lifecycle: 'failed' })
  })
  it('leaves ordinary mixed DAGs without repeat metadata or occurrence boundaries', () => {
    const f = makeCurrentWorkflowFixture('node-compat-ordinary')
    const version: WorkflowVersionV3 = structuredClone(f.version)
    version.definition.nodes.push(jobNode('build'))
    version.definition.edges.push({ id: 'build-edge', kind: 'execution', source: f.identities[1]!.workflowNodeId, target: 'build' })
    version.definition.executionPolicy!.maxNodeExecutions = 3
    const accepted = WorkflowVersionV3Schema.parse(version), before = structuredClone(accepted)
    const layout = compileRepeatLayout(accepted)
    expect(layout.boundaries).toEqual([])
    expect(layout.nodes.every((node) => node.kind === 'once')).toBe(true)
    expect(Object.hasOwn(accepted.definition, 'repeat')).toBe(false)
    expect(accepted).toEqual(before)
  })
  it('requires the accepted finite-repeat source with exact Run, attempt and configuration provenance', () => {
    const f = repeated(), source = { relationshipId: 'source-edge', execution: repeatExecutionIdentity(f.execution),
      occurrence: f.occurrence.identity, acceptedResult: f.execution.result!, acceptedResultDigest: repeatDigest(f.execution.result) }
    expect(() => assertRepeatSource(f.version, f.scope, source, f.execution, true)).not.toThrow()
    for (const patch of [{ id: 'replacement' }, { runId: 'other-run' }, { attempt: 2 },
      { agentConfigurationVersionId: 'other-config' }, { state: 'running' as const }]) {
      expect(() => assertRepeatSource(f.version, f.scope, source, { ...f.execution, ...patch }, true)).toThrow()
    }
    expect(() => assertRepeatSource(f.version, f.scope, source, f.execution, false)).toThrow()
    expect(() => assertRepeatSource(f.version, f.scope, { ...source, occurrence: null }, f.execution, true)).toThrow()
    expect(() => assertRepeatSource(f.version, f.scope, { ...source, execution: {
      kind: 'job', workflowNodeId: f.execution.workflowNodeId, executionId: f.execution.id, attempt: f.execution.attempt,
      jobDefinitionId: 'job-definition', jobDefinitionVersionId: 'job-version',
    } }, f.execution, true)).toThrow(expect.objectContaining({ code: 'REPEAT_INPUT_NOT_ACCEPTED' }))
    f.version.definition.nodes[1] = jobNode(f.block.exitNodeId)
    expect(() => assertRepeatExecution(f.version, f.scope, { nodeId: f.block.exitNodeId, occurrence: f.occurrence.identity }, f.execution))
      .toThrow(expect.objectContaining({ code: 'EXECUTION_OCCURRENCE_CONFLICT' }))
    expect(() => bindRepeatNodeInput({ version: f.version, runInput: {}, recipient: f.execution,
      ref: { nodeId: f.block.exitNodeId, occurrence: f.occurrence.identity }, occurrence: f.occurrence, entry: f.entry, predecessors: [] }))
      .toThrow(expect.objectContaining({ code: 'EXECUTION_OCCURRENCE_CONFLICT' }))
    expect(f.version.executionSemanticsVersion).toBe(3)
  })
  it.each(['agent', 'job'] as const)('preserves the full %s final repeat-export identity', (kind) => {
    const f = repeated()
    const decision = decideRepeatExit(f.version, f.occurrence, f.execution,
      { routing: { outcome: 'pass' }, data: { latestDeliverable: {}, remainingFindings: [] } }, f.createdAt)
    const exit: GraphExecutionIdentity = kind === 'agent' ? { ...repeatExecutionIdentity(f.execution), kind: 'agent' }
      : { kind: 'job', workflowNodeId: f.block.exitNodeId, executionId: f.execution.id, attempt: 1,
        jobDefinitionId: 'job-definition', jobDefinitionVersionId: 'job-version' }
    let full: RepeatDecisionV1 = { ...decision, exitExecution: { ...exit, occurrence: f.occurrence.identity } }
    if (kind === 'job') {
      f.version.definition.nodes[1] = { ...jobNode(f.block.exitNodeId), choice: { outcomes: [
        { outcome: 'succeeded', target: { kind: 'branch_end' } },
        { outcome: 'build_failed', target: { kind: 'branch_end' } },
      ] } }
      delete f.version.agentConfigurationVersionIds[f.execution.agentId]
      f.block.earlyExitOutcome = 'succeeded'
      f.block.repeatOutcome = 'build_failed'
      const accepted = { outcome: 'succeeded' as const, output: { routing: { outcome: 'succeeded' }, data: full.resultData } }
      full = { ...full, outcome: 'succeeded', acceptedResultDigest: repeatDigest(accepted) }
      expect(WorkflowVersionV3Schema.safeParse(f.version).success).toBe(true)
      expect(validateRepeatDecisionV1(f.version, full, accepted)).toEqual(full)
    } else {
      expect(validateRepeatDecisionV1(f.version, full, f.execution.result)).toEqual(full)
    }
    const local: RepeatResolution = { ref: { nodeId: f.block.exitNodeId, occurrence: f.occurrence.identity }, deferredRelationshipIds: [],
      value: { workflowNodeId: f.block.exitNodeId, execution: exit, resolution: 'succeeded', acceptedResultDigest: full.acceptedResultDigest,
        branchEnded: false, selectedRelationshipIds: [], unselectedRelationshipIds: [], resolvedAt: f.createdAt } }
    const before = structuredClone(local)
    expect(finalRepeatExport(f.version, local, full).value.execution).toEqual(exit)
    expect(local).toEqual(before)
    expect(() => finalRepeatExport(f.version, local, { ...full, exitExecution: { ...full.exitExecution, attempt: 2 } })).toThrow()
    expect(() => finalRepeatExport(f.version, local, { ...full, exitExecution: { ...full.exitExecution,
      occurrence: { ...f.occurrence.identity, occurrenceIndex: 2 } } })).toThrow()
    if (exit.kind === 'job') {
      expect(() => finalRepeatExport(f.version, local, { ...full,
        exitExecution: { ...exit, jobDefinitionVersionId: 'replacement', occurrence: f.occurrence.identity } })).toThrow()
    }
  })
})
