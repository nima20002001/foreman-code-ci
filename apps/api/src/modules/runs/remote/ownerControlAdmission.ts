import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { RemoteOwnerControlSchema, type RemoteOwnerControl } from '@foreman-code/contracts/remote-execution'
import type { InteractionDeliveryClaim } from '../../interactions/delivery.js'
import { assertInteractionNativeDispatchLocked, assertInteractionReservedRetryLocked } from '../../interactions/wave25/delivery.js'
import type { AcceptedExecutionBinding } from '../../placement/nativeComposition.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import { DomainError } from '../../errors.js'
import { prepareRemoteOwnerControl, type RemoteControlInput } from './ownerControl.js'
import { selectedInteractionResponse } from '../../interactions/delivery.js'

/** SQL-only admission. The caller delivers only after this G1 transaction COMMITs.
 * A committed admission is reconciliation-only even when its network ACK was lost. */
export async function admitRemoteOwnerControl(sql: GraphTransactionSql, owner: RunOwnership,
  binding: AcceptedExecutionBinding, input: RemoteControlInput, claim?: InteractionDeliveryClaim): Promise<RemoteOwnerControl> {
  assertGraphTransaction(sql)
  if (input.kind === 'stop' || input.workflowControl) return prepareRemoteOwnerControl(sql, owner, binding, input)
  if (!claim || claim.mode !== 'submit' || !/^[1-9][0-9]*$/.test(claim.deliveryFence ?? '')
    || !/^(0|[1-9][0-9]*)$/.test(claim.approvalConnectionGeneration ?? '')
    || claim.interaction.runId !== owner.runId || claim.interaction.executionId !== binding.intent.executionId
    || claim.interaction.nativeSessionId !== input.native.sessionId || claim.interaction.nativeRequestId !== input.nativeRequestId) {
    throw new DomainError('REMOTE_CONTROL_ORIGINAL_CLAIM_REQUIRED', 'Remote response admission requires its original exact delivery claim.', 409)
  }
  await assertInteractionNativeDispatchLocked(sql, claim)
  const control = await prepareRemoteOwnerControl(sql, owner, binding, input)
  if (control.action.kind !== 'respond' || control.action.interactionId !== claim.interaction.id) {
    throw new DomainError('REMOTE_CONTROL_ORIGINAL_CLAIM_REQUIRED', 'The response does not belong to the original delivery claim.', 409)
  }
  const stored = (await sql.query<{ remote_owner_control: unknown }>(`select remote_owner_control from interaction_delivery_attempts
    where interaction_id=$1 and attempt=$2 for update`, [claim.interaction.id, claim.attempt])).rows[0]
  if (stored?.remote_owner_control) {
    throw new DomainError('REMOTE_CONTROL_ALREADY_ADMITTED', 'The original remote response admission must be reconciled without resending.', 409)
  }
  const changed = await sql.query(`update interaction_delivery_attempts set remote_owner_control=$3::jsonb,
    remote_owner_control_token=$4,remote_owner_control_fence=$5::bigint,remote_owner_control_generation=$6::bigint
    where interaction_id=$1 and attempt=$2 and remote_owner_control is null and lease_owner=$4
      and delivery_fence=$5::bigint and approval_connection_generation=$6::bigint and lease_expires_at>clock_timestamp()`,
  [claim.interaction.id, claim.attempt, JSON.stringify(control), claim.ownerToken, claim.deliveryFence, claim.approvalConnectionGeneration])
  if (changed.rowCount !== 1) throw new DomainError('DELIVERY_OWNER_LOST', 'The original remote response delivery claim changed before admission.', 409)
  return control
}

/** Retained command readback only. This never permits another provider/native write. */
export async function readAdmittedRemoteOwnerControl(sql: GraphTransactionSql, owner: RunOwnership,
  binding: AcceptedExecutionBinding, claim: InteractionDeliveryClaim): Promise<RemoteOwnerControl | undefined> {
  assertGraphTransaction(sql); owner.assertOwned()
  if (owner.runId !== binding.intent.runId || claim.interaction.runId !== owner.runId
    || claim.interaction.executionId !== binding.intent.executionId) throw new DomainError('REMOTE_RUN_OWNER_CONFLICT', 'The original native Run scope is required.', 409)
  await owner.readOneShotFence(sql)
  const stored = (await sql.query<{ remote_owner_control: unknown }>(`select remote_owner_control from interaction_delivery_attempts
    where interaction_id=$1 and attempt=$2 for share`, [claim.interaction.id, claim.attempt])).rows[0]?.remote_owner_control
  if (!stored) return undefined
  const control = RemoteOwnerControlSchema.parse(stored)
  if (control.operationId !== binding.intent.operationId || control.attemptId !== binding.intent.attemptId
    || control.executionId !== binding.intent.executionId || control.bindingHash !== binding.intent.bindingHash
    || control.action.kind !== 'respond' || control.action.interactionId !== claim.interaction.id
    || !control.native || control.native.sessionId !== claim.interaction.nativeSessionId || control.action.nativeInteractionId !== claim.interaction.nativeRequestId
    || !sameWorkflowValue(control.action.response, selectedInteractionResponse(claim.interaction))) {
    throw new DomainError('REMOTE_CONTROL_ADMISSION_CONFLICT', 'The retained response admission identifies a different original operation.', 409)
  }
  return control
}

export async function authorizeReservedRemoteResponse(sql: GraphTransactionSql, owner: RunOwnership,
  binding: AcceptedExecutionBinding, claim: InteractionDeliveryClaim, command: RemoteOwnerControl): Promise<void> {
  const stored = await readAdmittedRemoteOwnerControl(sql, owner, binding, claim)
  if (!stored || !sameWorkflowValue(stored, command)) {
    throw new DomainError('REMOTE_CONTROL_ADMISSION_CONFLICT', 'The reserved response admission changed.', 409)
  }
  await assertInteractionReservedRetryLocked(sql, claim)
}
