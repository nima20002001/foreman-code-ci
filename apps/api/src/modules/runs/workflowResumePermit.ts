import type { DurableInteraction } from '@foreman-code/contracts'
import type { WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import type { ApprovalPostgresSaver } from '../../infrastructure/approvalCheckpointSaver.js'
import { DomainError } from '../errors.js'
import { currentRunGraphPublication } from '../run-graph/publication.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { consumeApprovalGraphResume } from '../interactions/wave25/resume.js'
import type { RunOwnership } from './ownership.js'

type WorkflowRunV3 = ReturnType<typeof WorkflowRunV3Schema.parse>

/** Only a confirmed atomic checkpoint/effect COMMIT mints this private permit.
 * Serialized IDs or an arbitrary Command can never move a waiting Run forward. */
export interface WorkflowResumePermit { readonly runId: string; readonly checkpointId: string }
interface CapturedResume {
  owner: RunOwnership; saver: ApprovalPostgresSaver; runId: string; versionId: string; checkpointId: string;
  fence: { ownerId: string; fence: string }; interactions: DurableInteraction[]
}
const resumePermits = new WeakMap<object, CapturedResume>()
export function mintWorkflowResumePermit(captured: CapturedResume): WorkflowResumePermit {
  const permit = Object.freeze({ runId: captured.runId, checkpointId: captured.checkpointId })
  resumePermits.set(permit, captured)
  return permit
}
export async function assertConsumedWorkflowResumeLocked(sql: GraphTransactionSql, owner: RunOwnership,
  run: WorkflowRunV3, permit: WorkflowResumePermit | undefined): Promise<void> {
  const captured = permit && resumePermits.get(permit)
  owner.assertOwned()
  if (!captured || captured.owner !== owner || captured.runId !== run.id || captured.versionId !== run.workflowVersionId
    || JSON.stringify(captured.fence) !== JSON.stringify(await owner.readOneShotFence(sql))) {
    throw new DomainError('GRAPH_RESUME_RECEIPT_MISSING', 'A waiting Run requires its exact committed checkpoint permit.', 409)
  }
  const publication = currentRunGraphPublication(sql, {
    workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3,
  })
  for (const interaction of captured.interactions) {
    if (await captured.saver.inspectApprovalInterrupt(sql, interaction) !== captured.checkpointId) {
      throw new DomainError('GRAPH_INTERRUPT_NOT_CURRENT', 'An old resume permit cannot release a new checkpoint.', 409)
    }
    await consumeApprovalGraphResume(publication, { interaction, ownerToken: '' }, async () => {
      throw new DomainError('GRAPH_RESUME_RECEIPT_MISSING', 'A resume permit cannot write another checkpoint.', 409)
    })
  }
}
