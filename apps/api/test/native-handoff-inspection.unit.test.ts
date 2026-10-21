import { describe, expect, it } from 'vitest'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { inspectionExecutionRowSummary } from '../src/modules/runs/inspection.js'
import { repeatDigest, repeatSlotId, workActivationSlotId } from '../src/modules/runs/repeatResolution.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

function fixture(outcome: 'succeeded' | 'failed' = 'succeeded') {
  const f = currentUnitSnapshot('native-work-inspection')
  f.version.definition.handoffs = { contractVersion: 1 }
  f.version.contentHash = repeatDigest({ definition: f.version.definition,
    configurations: f.version.agentConfigurationVersionIds, entryNodeId: f.version.entryNodeId })
  WorkflowVersionV3Schema.parse(f.version)
  const snapshot = { run: f.run, version: f.version, configurations: f.configurations, stopRequested: false, cleanupPending: false }
  const identity = f.identities[0]!
  const activationId = 'work-activation-original'
  const row = { id: identity.executionId, run_id: f.run.id, workflow_node_id: identity.workflowNodeId,
    agent_id: f.configurations[0]!.agentId, attempt: identity.attempt, repeat_occurrence_id: null,
    accepted: outcome === 'succeeded', summary: { ...identity, state: 'completed', createdAt: f.createdAt,
      finishedAt: f.createdAt, acceptedResultAvailable: outcome === 'succeeded' }, reported_outcome: outcome,
    page_created_at: f.createdAt, identity, identity_run_id: f.run.id, identity_occurrence_id: null,
    technical_attempt: identity.attempt, slot_id: workActivationSlotId(f.run.id, activationId),
    slot_run_id: f.run.id, slot_node_id: identity.workflowNodeId, slot_occurrence_id: null,
    work_activation_id: activationId as string | null, native_work_activation_id: activationId as string | null,
    attempt_work_activation_id: activationId as string | null,
    occurrence_id: null, occurrence_run_id: null, occurrence_workspace_id: null, occurrence_workflow_id: null,
    occurrence_version_id: null, occurrence_block_id: null, occurrence_index: null, occurrence_identity: null }
  return { snapshot, row }
}

describe('current handoff execution inspection activation pins', () => {
  it.each(['succeeded', 'failed'] as const)('reads exact %s metadata using its original work slot', (outcome) => {
    const { snapshot, row } = fixture(outcome)
    expect(inspectionExecutionRowSummary(row, snapshot)).toEqual(row.summary)
  })

  it.each(['work_activation_id', 'native_work_activation_id', 'attempt_work_activation_id'] as const)(
    'refuses a mismatched %s without replacing the slot identity', (field) => {
      const { snapshot, row } = fixture()
      row[field] = 'foreign-activation'
      expect(() => inspectionExecutionRowSummary(row, snapshot)).toThrow(expect.objectContaining({ code: 'RUN_INSPECTION_EVIDENCE_CONFLICT' }))
    })

  it('refuses a missing activation or a repeat slot on a marked handoff Run', () => {
    const { snapshot, row } = fixture()
    for (const changed of [
      { ...row, work_activation_id: null, native_work_activation_id: null, attempt_work_activation_id: null },
      { ...row, slot_id: repeatSlotId(snapshot.run.id, { nodeId: row.workflow_node_id, occurrence: null }) },
      { ...row, slot_run_id: 'foreign-run' },
    ]) expect(() => inspectionExecutionRowSummary(changed, snapshot)).toThrow(expect.objectContaining({ code: 'RUN_INSPECTION_EVIDENCE_CONFLICT' }))
  })
})
