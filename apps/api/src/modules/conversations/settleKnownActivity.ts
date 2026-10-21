import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { ActivityNativeIdentitySchema, OperatorActivitySchema, type ActivityNativeIdentity, type OperatorActivity } from '@foreman-code/contracts'
import type { OperatorActivityChange } from './operatorActivity.js'
import { nativePersistenceRedactor, type NativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { DomainError } from '../errors.js'

/** A known independent child/item may settle after its parent. This never inserts work or changes the current native owner. */
export async function settleKnownActivity(pool: pg.Pool, conversationId: string, requestId: string | undefined, change: OperatorActivityChange | Omit<OperatorActivityChange, 'requestId'>,
  actual: ActivityNativeIdentity, redact: NativePersistenceRedactor = nativePersistenceRedactor([])): Promise<{ activity: OperatorActivity; scopeRevision: string; itemRevision: string } | undefined> {
  const native = ActivityNativeIdentitySchema.parse(actual)
  if (!['completed', 'failed', 'canceled'].includes(change.status) || requestId !== undefined && 'requestId' in change && change.requestId !== requestId) return undefined
  return withTransaction(pool, async (client) => {
    const owner = await client.query('select id from operator_conversations where id=$1 and deleted_at is null for update', [conversationId])
    if (!owner.rowCount) return undefined
    const rows = (await client.query<{ request_id: string; activity_id: string; record: OperatorActivityChange; source_provenance: { native?: ActivityNativeIdentity;
      ownerNative?: ActivityNativeIdentity; ownerInputHash?: string }; sequence: string; revision: string; input_hash: string }>(`
      select a.request_id,a.activity_id,a.record,a.source_provenance,a.sequence::text,a.revision::text,t.input_hash from operator_conversation_activity a
        join operator_conversation_turns t on t.conversation_id=a.conversation_id and t.request_id=a.request_id
      where a.conversation_id=$1 and ($2::text is null or a.request_id=$2) and a.activity_id=$3
        and a.source_provenance->'native'=$4::jsonb order by a.sequence limit 2 for update of a`,
      [conversationId, requestId ?? null, change.id, JSON.stringify(native)])).rows
    if (rows.length !== 1) return undefined
    const row = rows[0]!
    const originalRequestId = row.request_id
    const stored = row?.source_provenance
    if (!row || !stored?.native || !stored.ownerNative?.turnId || !stored.ownerInputHash || stored.ownerInputHash !== row.input_hash
      || !['subagent', 'tool', 'mcp', 'web_search', 'file_read', 'file_write'].includes(row.record.kind)) {
      return undefined
    }
    const identityFields = ['harness', 'sessionId', 'turnId', 'requestId', 'itemId', 'partId', 'parentItemId', 'generation'] as const
    if (identityFields.some((field) => stored.native![field] !== undefined && stored.native![field] !== native[field])) {
      return undefined
    }
    // Session existence alone cannot prove an independent item/child invocation.
    if (!stored.native.turnId && !stored.native.parentItemId) return undefined
    const merged = { ...row.record, ...change, requestId: originalRequestId }
    const schema = OperatorActivitySchema.omit({ sequence: true, revision: true })
    const parsed = schema.parse({ ...merged, title: redact.text(merged.title),
      ...(merged.input !== undefined ? { input: redact.text(merged.input) } : {}),
      ...(merged.output !== undefined ? { output: redact.text(merged.output) } : {}) })
    if (['completed', 'failed', 'canceled'].includes(row.record.status)) {
      if (JSON.stringify(schema.parse(row.record)) !== JSON.stringify(parsed)) throw new DomainError('ACTIVITY_TERMINAL_CONFLICT', 'A settled item requires authoritative reconciliation.', 409)
      return undefined
    }
    const applied = (await client.query<{ revision: string }>(`update operator_conversation_activity set record=$4::jsonb,revision=revision+1
      where conversation_id=$1 and request_id=$2 and activity_id=$3 returning revision::text`, [conversationId, originalRequestId, change.id, JSON.stringify(parsed)])).rows[0]!
    const scope = (await client.query<{ revision: string }>('update operator_conversations set revision=revision+1 where id=$1 returning revision::text', [conversationId])).rows[0]!
    return { activity: OperatorActivitySchema.parse({ ...parsed, sequence: row.sequence, revision: Number(applied.revision) }),
      scopeRevision: scope.revision, itemRevision: applied.revision }
  })
}
