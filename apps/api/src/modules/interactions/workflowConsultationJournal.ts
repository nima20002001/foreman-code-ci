import { createHash } from 'node:crypto'
import { canonicalJson, type CoordinatorConsultationBinding, type NativeHarnessEvent,
  type NativeSessionReference } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { NativeHistory } from '../harnesses/port.js'
import type { SessionWriteLease } from './sessionWriter.js'

/** Captured by the existing coordinator, never obtained from a chat request. */
export interface ConsultationWriter {
  binding: CoordinatorConsultationBinding
  session: NativeSessionReference
  agentId: string
  lease: SessionWriteLease
  assertCurrent(): void
}

export async function assertConsultationWriterLocked(sql: GraphTransactionSql,
  writer: ConsultationWriter): Promise<void> {
  writer.assertCurrent()
  const { lease, binding, session } = writer
  const row = (await sql.query<{ valid: boolean }>(`select (
      l.owner_agent_id=$2 and l.harness=$3 and l.native_session_id=$4
      and l.record->>'leaseOwner'=$2 and l.record->>'leaseToken'=$5
      and l.record->>'connectionGeneration'=$6
      and l.record->>'correlationId'=$7
      and (l.record->>'leaseExpiresAt')::timestamptz>clock_timestamp()
      and c.binding=$9::jsonb and (m.state='canceled'
        or m.state='consultation' and m.active_consultation_id=c.id)
      and c.state in ('admitted','active','unknown','settling')) as valid
    from native_session_lanes l cross join run_coordinator_consultations c
    join run_coordinator_mailboxes m on m.run_id=c.run_id and m.waiting_activation_id=c.waiting_activation_id
    where l.id=$1 and c.run_id=$8 and c.id=$10 for update of l,c,m`,
  [lease.fence.id, writer.agentId, session.harness, session.nativeSessionId, lease.fence.token,
    String(lease.previous.connectionGeneration), lease.correlationId, binding.runId,
    canonicalJson(binding), binding.consultationId])).rows[0]
  if (!row?.valid || session.nativeSessionId !== binding.nativeSessionId
    || lease.correlationId !== `consultation:${binding.consultationId}`) throw new DomainError(
    'COORDINATOR_NATIVE_OWNER_CHANGED', 'The exact consultation no longer owns this native writer.', 409)
  writer.assertCurrent()
}

/** Original observer events retain their native IDs. The hash only deduplicates
 * the same original event across the stream/history reply gap. */
export async function appendConsultationNativeLocked(sql: GraphTransactionSql, writer: ConsultationWriter,
  input: { events: readonly NativeHarnessEvent[]; history?: NativeHistory; now: string }): Promise<void> {
  await assertConsultationWriterLocked(sql, writer)
  for (const event of input.events) {
    const record = canonicalJson(event)
    const sourceId = createHash('sha256').update(record).digest('hex')
    await sql.query(`insert into run_coordinator_native_events(consultation_id,run_id,source_id,record,created_at)
      values($1,$2,$3,$4::jsonb,$5) on conflict(consultation_id,source_id) do nothing`,
    [writer.binding.consultationId, writer.binding.runId, sourceId, record, input.now])
  }
  if (input.history) await sql.query(`insert into run_coordinator_native_history
    (consultation_id,run_id,revision,history,observed_at) values($1,$2,1,$3::jsonb,$4)
    on conflict(consultation_id) do update set history=excluded.history,
      revision=run_coordinator_native_history.revision+1,observed_at=excluded.observed_at
    where run_coordinator_native_history.run_id=excluded.run_id
      and run_coordinator_native_history.history is distinct from excluded.history`,
  [writer.binding.consultationId, writer.binding.runId, canonicalJson(input.history), input.now])
  writer.assertCurrent()
}
