import { HarnessNativeEventSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import { RunGraphError } from '../run-graph/errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { normalizeNativeProducerEvent, NATIVE_PRODUCER_REJECTION_TYPE, NATIVE_PRODUCER_REJECTION_VERSION,
  type NormalizedNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'

/** The native-event insert, sequence allocation and Run Activity reference commit atomically. */
export async function appendNativeEvent(client: pg.Pool | pg.ClientBase, event: HarnessNativeEvent): Promise<void> {
  await appendNormalizedNativeEvent(client, normalizeNativeProducerEvent(event))
}

/** Shared raw append for the production callbacks and G1 ingester. G1 callers
 * check their existing owner/generation guards before entering this SQL boundary.
 * This function does not acquire ownership or begin/commit a caller transaction. */
export async function appendNormalizedNativeEvent(client: GraphSqlClient,
  normalized: NormalizedNativeProducerEvent): Promise<{ inserted: boolean; rejected: boolean }> {
  const parsed = HarnessNativeEventSchema.parse(normalized.event)
  if (!Number.isSafeInteger(parsed.sequence) || parsed.sequence > 2147483647) {
    throw new DomainError('GRAPH_EVIDENCE_INVALID', 'The native source sequence must fit the durable integer identity.', 409)
  }
  try {
    if (normalized.rejected) {
      // Older writers may already have retained the original oversized raw row.
      // Keep that row byte-for-byte: recognizing its rejection must not try to
      // overwrite it with a marker (PNE01), nor re-append the original payload.
      // Restore source numbering only for normalization; never rewrite storage.
      const existing = (await client.query<{ record: HarnessNativeEvent }>(
        `select record from harness_native_events where execution_id=$1
          and (($2::text is not null and connection_id=$2 and source_sequence=$3)
            or ($2::text is null and connection_id is null and sequence=$3))`,
        [parsed.executionId, parsed.connectionId ?? null, parsed.sequence])).rows[0]
      if (existing && normalizeNativeProducerEvent({ ...existing.record, sequence: parsed.sequence }).rejected) {
        return { inserted: false, rejected: true }
      }
    }
    // A rejection is an absorbing *negative* source receipt. Even a later bounded
    // variant of that source must not replace it or be offered to graph evidence.
    // The append remains one statement in Pool/autocommit/caller composition.
    // The existing function still locks the execution and owns allocation/CAS.
    // A competing different body remains PNE01; no blind retry or conflict swallow.
    const result = await client.query<{ inserted: boolean; previously_rejected: boolean }>(
      `with rejected_source as (
         select 1 from harness_native_events n where n.execution_id=$2
           and (($3::text is not null and n.connection_id=$3 and n.source_sequence=$4)
             or ($3::text is null and n.connection_id is null and n.sequence=$4))
           and n.record->>'type'=$5 and n.record->'payload'->>'normalization'=$6
       )
       select case when exists(select 1 from rejected_source) then false
         else append_harness_native_event($1::jsonb) end as inserted,
         exists(select 1 from rejected_source) as previously_rejected`,
      [JSON.stringify(parsed), parsed.executionId, parsed.connectionId ?? null, parsed.sequence,
        NATIVE_PRODUCER_REJECTION_TYPE, NATIVE_PRODUCER_REJECTION_VERSION])
    return { inserted: result.rows[0]!.inserted,
      rejected: normalized.rejected || result.rows[0]!.previously_rejected }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'PNE01') {
      throw new DomainError('NATIVE_EVENT_IDENTITY_CONFLICT', 'The native source identity is already bound to different history.', 409, undefined, { cause: error })
    }
    throw error
  }
}

/** Translate provider positions without changing their stored source identity. */
export async function readPersistedNativeSequence(client: GraphSqlClient, event: HarnessNativeEvent): Promise<string> {
  const result = await client.query<{ sequence: string }>(
    `select sequence::text from harness_native_events where execution_id=$1
      and (($2::text is not null and connection_id=$2 and source_sequence=$3)
        or ($2::text is null and connection_id is null and sequence=$3))`,
    [event.executionId, event.connectionId ?? null, event.sequence])
  if (result.rows.length !== 1) {
    throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  }
  return result.rows[0]!.sequence
}
