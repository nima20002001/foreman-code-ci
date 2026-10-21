import type pg from 'pg'
import type { DurableInteraction } from '@foreman-code/contracts'

/** Projection only: inspect the existing immutable worker ack and original native proof, never grant response authority. */
export async function readActivityAcknowledgment(query: Pick<pg.PoolClient, 'query'>, interaction: DurableInteraction): Promise<{
  workerAcknowledgmentId?: string; nativeTurnId?: string
}> {
  if (interaction.status !== 'delivered' || interaction.deliveryState !== 'delivered') return {}
  const row = (await query.query<{ worker_acknowledgment_id: string; native_turn_id: string | null }>(`
    select g.approval_native_ack_id as worker_acknowledgment_id,
      coalesce(p.record#>>'{original,history,nativeTurnId}',p.record#>>'{lane,providerId}') as native_turn_id
    from durable_interactions i join interaction_graph_resumes g on g.interaction_id=i.id and g.run_id=i.run_id and g.execution_id=i.execution_id
    join workflow_native_proofs p on p.proof_id=g.approval_native_ack_record->>'originalProofId' and p.run_id=i.run_id and p.execution_id=i.execution_id
    where i.id=$1 and i.run_id=$2 and i.execution_id=$3 and i.native_session_id=$4 and i.native_request_id=$5 and i.revision=$6
      and i.status='delivered' and i.record->>'deliveryState'='delivered' and g.state='resumed'
      and g.approval_native_ack_id is not null and g.approval_native_ack_record->>'acknowledgementId'=g.approval_native_ack_id
      and g.approval_native_ack_source=g.approval_native_ack_record->'nativeSource'
      and g.approval_native_ack_record#>>'{interaction,id}'=i.id
      and g.approval_native_ack_record#>>'{interaction,runId}'=i.run_id
      and g.approval_native_ack_record#>>'{interaction,executionId}'=i.execution_id
      and g.approval_native_ack_record#>>'{interaction,nativeSessionId}'=i.native_session_id
      and g.approval_native_ack_record#>>'{interaction,nativeRequestId}'=i.native_request_id
      and p.record#>>'{session,nativeSessionId}'=i.native_session_id`,
  [interaction.id, interaction.runId, interaction.executionId, interaction.nativeSessionId, interaction.nativeRequestId, interaction.revision])).rows[0]
  return row ? { workerAcknowledgmentId: row.worker_acknowledgment_id, ...(row.native_turn_id ? { nativeTurnId: row.native_turn_id } : {}) } : {}
}
