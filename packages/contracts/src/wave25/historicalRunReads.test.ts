import { describe, expect, it } from 'vitest'
import { makeSharedV3Fixture } from './eng04-shared-fixture.js'
import { WorkflowVersionV3Schema,
  SavedWorkflowVersionSchema, SavedWorkflowVersionDetailSchema, SavedWorkflowVersionPageSchema,
  SavedRunVersionSnapshotSchema } from './saved.js'
import { CurrentRunVersionSnapshotSchema, CurrentWorkflowVersionDetailSchema,
  CurrentWorkflowVersionPageSchema } from './currentRead.js'
import { WorkflowVersionResultSchema, WorkflowVersionPageSchema } from '../management/extensions.js'
import { RunVersionDetailSchema } from './runInspection.js'
import { RepeatWorkflowReadbackSchema } from './repeatReadback.js'
import { RepeatRunVersionV1Schema, RepeatOccurrenceV1Schema, RepeatDecisionMetadataV1Schema } from './repeat.js'
import { repeatGraphTopologyV3, validateRepeatGraphSnapshotV3 } from './repeatGraphMetadata.js'
import { validateRepeatMetadataSnapshotV1 } from './repeatMetadata.js'

function historical() {
  const f = makeSharedV3Fixture('historical-job')
  const oldExit = f.version.definition.nodes[1]!
  const job = { kind: 'job' as const, id: oldExit.id, name: 'Historical build',
    jobDefinitionId: 'old-build', jobDefinitionRevision: 7, jobDefinitionVersionId: 'old-build-version',
    choice: { outcomes: [
      { outcome: 'succeeded', target: { kind: 'branch_end' as const } },
      { outcome: 'build_failed', target: { kind: 'branch_end' as const } },
    ] } }
  const pins = Object.fromEntries(Object.entries(f.version.agentConfigurationVersionIds)
    .filter(([agentId]) => agentId !== f.configurations[1]!.agentId))
  const version = { ...f.version, agentConfigurationVersionIds: pins, definition: { ...f.version.definition,
    nodes: [f.version.definition.nodes[0]!, job], repeat: { ...f.version.definition.repeat!,
      blocks: f.version.definition.repeat!.blocks.map(block => ({ ...block,
        repeatOutcome: 'build_failed', earlyExitOutcome: 'succeeded' })) } } }
  return { ...f, version, run: { ...f.run, agentConfigurationVersionIds: pins }, job }
}

const pairReaders = { SavedRunVersionSnapshotSchema, CurrentRunVersionSnapshotSchema, RepeatRunVersionV1Schema }
const detailReaders = { SavedWorkflowVersionDetailSchema, CurrentWorkflowVersionDetailSchema, WorkflowVersionResultSchema }
const pageReaders = { SavedWorkflowVersionPageSchema, CurrentWorkflowVersionPageSchema, WorkflowVersionPageSchema }

describe('stored V3 Run and version readers preserve existing immutable history', () => {
  it('preserves the exact historical version and Job definition pins', () => {
    const f = historical()
    for (const schema of [WorkflowVersionV3Schema, SavedWorkflowVersionSchema]) {
      expect(schema.parse(f.version)).toEqual(f.version)
    }
  })
  it.each(Object.entries(pairReaders))('%s reads the exact pinned historical Run', (_name, schema) => {
    const f = historical()
    expect(schema.parse({ run: f.run, version: f.version })).toEqual({ run: f.run, version: f.version })
    for (const run of [
      { ...f.run, workspaceId: 'other' }, { ...f.run, workflowId: 'other' },
      { ...f.run, workflowVersionId: 'other' }, { ...f.run, agentConfigurationVersionIds: {} },
      { ...f.run, approval: undefined }, { ...f.run, executionCondition: { kind: 'on_event' } },
    ]) expect(schema.safeParse({ run, version: f.version }).success).toBe(false)
  })
  it.each(Object.entries(detailReaders))('%s reads stored versions without migration', (_name, schema) => {
    const f = historical()
    expect(schema.parse({ version: f.version })).toEqual({ version: f.version })
    expect(schema.safeParse({ version: { ...f.version, unexpected: true } }).success).toBe(false)
  })
  it.each(Object.entries(pageReaders))('%s lists stored versions without rewriting them', (_name, schema) => {
    const f = historical(), page = { items: [f.version], pageInfo: { nextCursor: null } }
    expect(schema.parse(page)).toEqual(page)
  })
  it('keeps Run inspection and workflow readback identities exact', () => {
    const f = historical(), detail = { scope: f.scope, version: f.version }
    expect(RunVersionDetailSchema.parse(detail)).toEqual(detail)
    for (const scope of [
      { ...f.scope, workspaceId: 'other' }, { ...f.scope, workflowId: 'other' },
      { ...f.scope, workflowVersionId: 'other' },
    ]) expect(RunVersionDetailSchema.safeParse({ ...detail, scope }).success).toBe(false)
    const readback = { contractVersion: 1, executionSemanticsVersion: 3,
      workspaceId: f.version.workspaceId, workflowId: f.version.workflowId,
      currentVersionId: f.version.id, revision: 7, version: f.version }
    expect(RepeatWorkflowReadbackSchema.parse(readback)).toEqual(readback)
    expect(RepeatWorkflowReadbackSchema.safeParse({ ...readback, currentVersionId: 'other' }).success).toBe(false)
  })
  it('reads historical graph topology and rejects substituted Job definition pins', () => {
    const f = historical(), topology = repeatGraphTopologyV3(f.version)
    expect(topology.nodes[1]).toEqual({ kind: 'job', workflowNodeId: f.job.id,
      jobDefinitionId: f.job.jobDefinitionId, jobDefinitionVersionId: f.job.jobDefinitionVersionId, choice: f.job.choice })
    const snapshot = { kind: 'snapshot', protocolVersion: 1, scope: f.scope, asOfSequence: '0', retentionFloor: '0',
      historyCoverage: 'from_admission', topology,
      state: { run: { executionState: 'queued', outcome: 'pending', stopRequested: false, cleanupPending: false,
        unsettledReviewCount: 0, pendingInteractionCount: 0 }, nodes: [], inputBindings: [], interactions: [], reviews: [],
        occurrences: [], executions: [], resolutions: [], results: [], bindings: [], decisions: [] } }
    expect(validateRepeatGraphSnapshotV3(f.version, snapshot)).toEqual(snapshot)
    const changed = { ...f.version, definition: { ...f.version.definition,
      nodes: [f.version.definition.nodes[0]!, { ...f.job, jobDefinitionVersionId: 'substituted' }] } }
    expect(() => validateRepeatGraphSnapshotV3(changed, snapshot)).toThrow('REPEAT_GRAPH_PIN_CONFLICT')
  })
  it('reads historical repeat decisions through the exact Job exit identity', () => {
    const f = historical(), digest = `sha256:${'b'.repeat(64)}`
    const occurrence = RepeatOccurrenceV1Schema.parse({ contractVersion: 1,
      identity: { scope: f.scope, blockId: 'repair', occurrenceId: 'occurrence-1', occurrenceIndex: 1 },
      input: { bindingId: 'input-1', inputDigest: digest, previous: null } })
    const exitExecution = { kind: 'job', workflowNodeId: f.job.id, executionId: 'old-job-execution',
      jobDefinitionId: f.job.jobDefinitionId, jobDefinitionVersionId: f.job.jobDefinitionVersionId,
      attempt: 1, occurrence: occurrence.identity }
    const decision = RepeatDecisionMetadataV1Schema.parse({ contractVersion: 1, decisionId: 'decision-1', occurrence,
      exitExecution, acceptedResultDigest: digest, outcome: 'succeeded', reason: 'early_exit',
      target: { kind: 'branch_end' }, decidedAt: f.createdAt })
    const snapshot = { kind: 'snapshot', contractVersion: 1, scope: f.scope, throughSequence: '1', headSequence: '1',
      retentionFloor: '0', complete: true, items: [{ occurrence, decision }] }
    expect(validateRepeatMetadataSnapshotV1(f.version, snapshot)).toEqual(snapshot)
    const substituted = { ...snapshot, items: [{ occurrence, decision: { ...decision,
      exitExecution: { ...decision.exitExecution, jobDefinitionVersionId: 'substituted' } } }] }
    expect(() => validateRepeatMetadataSnapshotV1(f.version, substituted)).toThrow('REPEAT_METADATA_VERSION_OR_LINEAGE_MISMATCH')
  })
  it('rejects malformed stored nodes and retired semantics without retagging', () => {
    const f = historical()
    for (const version of [
      { ...f.version, executionSemanticsVersion: 2 },
      { ...f.version, definition: { ...f.version.definition, executionSemanticsVersion: 2 } },
      { ...f.version, definition: { ...f.version.definition, nodes: [{ ...f.job, jobDefinitionVersionId: undefined }] } },
      { ...f.version, definition: { ...f.version.definition, nodes: [{ ...f.job, agentId: 'invented' }] } },
    ]) expect(SavedWorkflowVersionSchema.safeParse(version).success).toBe(false)
  })
})
