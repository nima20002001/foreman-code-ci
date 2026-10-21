import { DurableInteractionSchema } from '@foreman-code/contracts'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { RemoteOwnerControlSchema, RemoteOperationReceiptSchema, remoteActiveNative, type RemoteOwnerControl } from '@foreman-code/contracts/remote-execution'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { assertGraphTransaction } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import type { AcceptedExecutionBinding } from '../../placement/nativeComposition.js'
import type { RemoteNativeManagerOptions } from './nativeManagerProxy.js'
import { DomainError } from '../../errors.js'
import { canCloseRetainedRemoteReviewer } from '../../placement/remoteReviewerAuthority.js'
import { selectedInteractionResponse } from '../../interactions/delivery.js'

export type RemoteControlInput = Parameters<RemoteNativeManagerOptions['controlFor']>[0]
/** SQL-only preparation inside the admitted Main transaction. The caller must
 * persist the exact command with its delivery fence before COMMIT, then deliver
 * outside G1. Preparation alone never authorizes a worker/native effect. */
export async function prepareRemoteOwnerControl(sql: GraphTransactionSql, owner: RunOwnership,
  binding: AcceptedExecutionBinding, command: RemoteControlInput): Promise<RemoteOwnerControl> {
  assertGraphTransaction(sql)
  owner.assertOwned()
  if (owner.runId !== binding.intent.runId) throw new DomainError('REMOTE_RUN_OWNER_CONFLICT', 'The original native Run owner is required.', 409)
  await owner.readOneShotFence(sql)
  const stored = (await sql.query<{ receipt: unknown }>('select receipt from remote_execution_receipts where operation_id=$1 for share', [binding.intent.operationId])).rows[0]
  const receipt = stored ? RemoteOperationReceiptSchema.parse(stored.receipt) : undefined
  if (!receipt || !sameWorkflowValue(receipt.intent, binding.intent) || !sameWorkflowValue(remoteActiveNative(receipt), command.native)
    || receipt.terminal || binding.placement.bindingHash !== binding.intent.bindingHash) throw new DomainError('REMOTE_CONTROL_UNAVAILABLE', 'The exact committed original native ownership is required.', 409)
  let commandId: string, action: { kind: 'stop' } | { kind: 'respond'; interactionId: string; interactionRevision: string; nativeInteractionId: string; response: unknown }
  let target: Pick<RemoteOwnerControl, 'native' | 'nativeTarget'> = { native: command.native }
  if (command.kind === 'stop') {
    const cleanup = (await sql.query<{ requested_at: Date }>('select requested_at from run_cleanup_intents where run_id=$1 and pending for share', [owner.runId])).rows[0]
    if (cleanup) {
      commandId = `stop:${binding.intent.operationId}:${cleanup.requested_at.toISOString()}`
      if (receipt.retainedReviewer) {
        // Run cleanup closes the session even if its review turn advances before delivery.
        target = { nativeTarget: { kind: 'session', sessionId: command.native.sessionId } }
      }
    } else if ((await sql.query(`select 1 from approval_execution_state
      where execution_id=$1 and failure_result is not null for share`, [binding.intent.executionId])).rowCount === 1) {
      commandId = `stop-failed-attempt:${binding.intent.operationId}`
    } else if (!receipt.reviewTurns?.some(turn => !turn.settled)
      && await canCloseRetainedRemoteReviewer(sql, receipt)) {
      commandId = `close-reviewer:${binding.intent.operationId}`
    } else {
      throw new DomainError('REMOTE_CONTROL_UNAVAILABLE',
        'The original accepted Run cleanup intent is required for remote Stop.', 409)
    }
    action = { kind: 'stop' }
  } else {
    const rows = await sql.query<{ record: unknown }>('select record from durable_interactions where execution_id=$1 and native_session_id=$2 and native_request_id=$3 for share', [binding.intent.executionId, command.native.sessionId, command.nativeRequestId])
    const interaction = rows.rows.length === 1 ? DurableInteractionSchema.parse(rows.rows[0]!.record) : undefined
    const selected = interaction && selectedInteractionResponse(interaction)
    if (!interaction || !selected || !['decided', 'delivery_pending', 'delivery_failed'].includes(interaction.status) || !sameWorkflowValue(selected, command.option)
      || interaction.revision < 1 || interaction.runId !== owner.runId || interaction.executionId !== binding.intent.executionId
      || interaction.nativeSessionId !== command.native.sessionId || interaction.nativeRequestId !== command.nativeRequestId) throw new DomainError('REMOTE_CONTROL_UNAVAILABLE', 'The actual committed exact native response decision is required.', 409)
    commandId = `respond:${interaction.id}:${interaction.revision}`
    action = { kind: 'respond', interactionId: interaction.id, interactionRevision: String(interaction.revision), nativeInteractionId: interaction.nativeRequestId, response: selected }
  }
  return RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1, commandId,
    operationId: binding.intent.operationId, attemptId: binding.intent.attemptId, executionId: binding.intent.executionId,
    bindingHash: binding.intent.bindingHash, owner: binding.intent.owner, ...target, action })
}
