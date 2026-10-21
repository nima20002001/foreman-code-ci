import { OperatorActivityPageSchema, OperatorActivityQuerySchema, OperatorActivitySchema, type OperatorActivity, type OperatorActivityQuery, ActivityNativeIdentitySchema, WorkRefSchema, type ActivityNativeIdentity, type WorkRef } from '@foreman-code/contracts'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import type { NativeMessageSubmission } from '../harnesses/port.js'
import type { NativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { settleKnownActivity } from './settleKnownActivity.js'
import { conversationActivityKey } from './activityIdentity.js'
import { assertConversationCursor, withConversationPageRead } from './activityCursor.js'
import type { OperatorActivityChange } from './operatorActivity.js'

export interface ActivityMutationFence {
  connectionId?: string
  nativeGeneration?: string
  native?: ActivityNativeIdentity
  itemNative?: ActivityNativeIdentity
  parent?: WorkRef
  nativeSessionId?: string
  nativeTurnId?: string
  nativeSubmission?: NativeMessageSubmission
  source?: { eventId?: string; sequence?: string; nativeSequence?: string; transportSequence?: number; system?: string; observedAt?: string; connectionId?: string }
  onReconciliationRequired?: () => void
  /** Only reconciled native history may correct terminal content. */
  authoritativeReconciliation?: boolean
}

type Queryable = Pick<pg.PoolClient, 'query'>
const changeSchema = OperatorActivitySchema.omit({ sequence: true, revision: true })

export class PostgresOperatorActivityRepository {
  constructor(private readonly pool: pg.Pool) {}

  settleKnownByNative(conversationId: string, change: Omit<OperatorActivityChange, 'requestId'>, actual: ActivityNativeIdentity, redact?: NativePersistenceRedactor) {
    return settleKnownActivity(this.pool, conversationId, undefined, change, actual, redact)
  }

  settleKnownActivity(conversationId: string, requestId: string, change: OperatorActivityChange, actual: ActivityNativeIdentity, redact?: NativePersistenceRedactor) {
    return settleKnownActivity(this.pool, conversationId, requestId, change, actual, redact)
  }

  async append(conversationId: string, requestId: string, input: OperatorActivityChange, fence: ActivityMutationFence = {}): Promise<{ activity: OperatorActivity; revision: number; scopeRevision: string; itemRevision: string } | undefined> {
    const value = changeSchema.parse(input)
    if (value.requestId !== requestId) throw new Error('Activity belongs to a different request.')
    for (const sequence of [fence.source?.sequence, fence.source?.nativeSequence]) {
      if (sequence !== undefined && !/^(0|[1-9][0-9]*)$/.test(sequence)) throw new Error('Invalid native source sequence.')
    }
    let reconciliationRequired = false
    const appended = await withTransaction(this.pool, async (client) => {
      const owner = await client.query(`select id,harness from operator_conversations where id=$1 and active_request_id=$2 and deleted_at is null
        and ($3::text is null or native_session_id=$3) and ($4::text is null or active_native_turn_id=$4) for update`,
      [conversationId, requestId, fence.nativeSessionId ?? fence.native?.sessionId ?? null, fence.nativeTurnId ?? fence.native?.turnId ?? null])
      if (!owner.rowCount || fence.native && owner.rows[0]?.harness !== fence.native.harness) return undefined
      if (owner.rows[0]?.harness === 'claude') {
        const receipt = fence.nativeSubmission
        const admitted = receipt?.kind === 'message' && fence.nativeTurnId === undefined && fence.native?.turnId === undefined
          && (await client.query(`select 1 from operator_conversation_turns where conversation_id=$1 and request_id=$2
            and payload->'nativeSubmission'=$3::jsonb for update`, [conversationId, requestId, JSON.stringify(receipt)])).rowCount
        if (!admitted) return undefined
      }
      const prior = (await client.query<{ record: OperatorActivityChange; source_provenance: ActivityMutationFence['source'] }>(
        `select record,source_provenance from operator_conversation_activity where conversation_id=$1 and request_id=$2 and activity_id=$3 for update`,
      [conversationId, requestId, value.id])).rows[0]
      const stored = prior?.source_provenance ?? {}
      const native = fence.itemNative ?? fence.native
      const ownerInputHash = fence.native ? (await client.query<{ input_hash: string }>(
        'select input_hash from operator_conversation_turns where conversation_id=$1 and request_id=$2', [conversationId, requestId])).rows[0]?.input_hash : undefined
      const connectionId = fence.connectionId ?? fence.source?.connectionId
      const nativeSequence = fence.source?.nativeSequence ?? (connectionId === undefined ? fence.source?.sequence : undefined)
      const legacyTransport = connectionId !== undefined && fence.source?.sequence !== undefined ? Number(fence.source.sequence) : undefined
      const transportSequence = fence.source?.transportSequence ?? (Number.isSafeInteger(legacyTransport) ? legacyTransport : undefined)
      const previousNative = stored.nativeSequence ?? (stored.connectionId === undefined ? stored.sequence : undefined)
      const previousTransport = stored.transportSequence ?? (stored.connectionId !== undefined && stored.sequence !== undefined ? Number(stored.sequence) : undefined)
      const sameConnection = connectionId !== undefined && connectionId === stored.connectionId
      const retainTransport = fence.authoritativeReconciliation && (connectionId === undefined || sameConnection)
      const source = { ...(fence.authoritativeReconciliation ? stored : {}), ...(fence.nativeSubmission ? { nativeSubmission: fence.nativeSubmission } : {}), schemaVersion: 1, system: 'conversation_activity', ...fence.source,
        connectionId: connectionId ?? (fence.authoritativeReconciliation ? stored.connectionId : undefined),
        sequence: fence.source?.sequence ?? (retainTransport ? stored.sequence : undefined),
        nativeSequence: nativeSequence ?? (fence.authoritativeReconciliation ? previousNative : undefined),
        transportSequence: transportSequence ?? (retainTransport ? previousTransport : undefined),
        ...(native ? { native: ActivityNativeIdentitySchema.parse(native) } : {}),
        ...(fence.native ? { ownerNative: ActivityNativeIdentitySchema.parse(fence.native), ownerInputHash } : {}),
        ...(fence.parent ? { parent: WorkRefSchema.parse(fence.parent) } : {}) }
      // Retained history watermarks are not newly observed ordering evidence.
      const orderedNative = nativeSequence !== undefined && previousNative !== undefined
      const orderedTransport = sameConnection && transportSequence !== undefined && previousTransport !== undefined
      const merged = prior ? { ...prior.record, ...value } : value
      // Compare parsed allowlisted facts, independent of JSONB key order.
      const changed = !prior || JSON.stringify(changeSchema.parse(prior.record)) !== JSON.stringify(changeSchema.parse(merged))
      const stale = fence.source?.eventId !== undefined && fence.source.eventId === stored.eventId
        || orderedNative && BigInt(nativeSequence!) <= BigInt(previousNative!)
        || orderedTransport && transportSequence! <= previousTransport!
      const terminal = prior && ['completed', 'failed', 'canceled'].includes(prior.record.status)
      const ambiguous = prior && changed && (stored.connectionId !== undefined && !sameConnection
        || prior.record.status === value.status && !orderedNative && !orderedTransport)
      if (stale || terminal && changed && (!fence.authoritativeReconciliation || prior.record.status !== value.status)
        || ambiguous && !fence.authoritativeReconciliation || prior?.record.status === 'running' && value.status === 'pending') {
        reconciliationRequired = Boolean(ambiguous && !stale && !fence.authoritativeReconciliation)
        return undefined
      }
      if (!changed) {
        // An identical newer native observation advances the private watermark, never public revisions.
        if ((orderedNative || orderedTransport) && !fence.authoritativeReconciliation) await client.query(`update operator_conversation_activity set source_provenance=$4::jsonb
          where conversation_id=$1 and request_id=$2 and activity_id=$3`, [conversationId, requestId, value.id, JSON.stringify(source)])
        return undefined
      }
      const applied = (await client.query<{ record: unknown; sequence: string; revision: string }>(`
        insert into operator_conversation_activity as activity (conversation_id,request_id,activity_id,record,source_provenance)
          values ($1,$2,$3,$4::jsonb,$5::jsonb)
        on conflict(conversation_id,request_id,activity_id) do update set record=excluded.record,
          source_provenance=excluded.source_provenance,revision=activity.revision+1
        returning record,sequence::text,revision::text`, [conversationId, requestId, value.id, JSON.stringify(merged), JSON.stringify(source)])).rows[0]!
      const revision = (await client.query<{ revision: string }>(`update operator_conversations set revision=revision+1 where id=$1 returning revision::text`, [conversationId])).rows[0]!.revision
      return { activity: OperatorActivitySchema.parse({ ...(applied.record as object), sequence: applied.sequence, revision: Number(applied.revision) }), revision: Number(revision), scopeRevision: revision, itemRevision: applied.revision }
    })
    if (reconciliationRequired) fence.onReconciliationRequired?.()
    return appended
  }

  async page(conversationId: string, input: Partial<OperatorActivityQuery> = {}, query: Queryable = this.pool): Promise<{ activities: OperatorActivity[]; nextCursor: string | null; itemRevisions: Record<string, string> }> {
    const { before, limit, requestId, activityId } = OperatorActivityQuerySchema.parse(input)
    if (query === this.pool && before !== undefined) return withConversationPageRead(this.pool, (sql) => this.page(conversationId, input, sql))
    await assertConversationCursor(query, conversationId, before, 'activity')
    const result = await query.query<{ record: unknown; sequence: string; revision: string }>(`
      select record,sequence::text,revision::text from operator_conversation_activity
      where conversation_id=$1 and ($2::bigint is null or sequence<$2::bigint)
        and ($4::text is null or request_id=$4) and ($5::text is null or activity_id=$5)
      order by operator_conversation_activity.sequence desc limit $3`,
    [conversationId, before ?? null, limit + 1, requestId ?? null, activityId ?? null])
    const rows = result.rows.slice(0, limit)
    const page = OperatorActivityPageSchema.parse({
      activities: rows.reverse().map((row) => ({ ...(row.record as object), sequence: row.sequence, revision: Number(row.revision) })),
      nextCursor: result.rows.length > limit ? result.rows[limit - 1]!.sequence : null,
    })
    return { ...page, itemRevisions: Object.fromEntries(rows.map((row) => [conversationActivityKey((row.record as { requestId: string }).requestId, (row.record as { id: string }).id), row.revision])) }
  }

  /** The unfinished roster is independent of chronological history paging. */
  async snapshotPage(conversationId: string, input: Partial<OperatorActivityQuery> = {}, query: Queryable = this.pool): Promise<Awaited<ReturnType<PostgresOperatorActivityRepository['page']>> & { itemProvenance: Record<string, unknown> }> {
    if (query === this.pool) return withConversationPageRead(this.pool, (sql) => this.snapshotPage(conversationId, input, sql))
    const page = await this.page(conversationId, input, query)
    const keys = page.activities.map((activity) => ({ requestId: activity.requestId, id: activity.id }))
    const rows = keys.length ? (await query.query<{ request_id: string; activity_id: string; source_provenance: unknown }>(`
      select request_id,activity_id,source_provenance from operator_conversation_activity where conversation_id=$1
        and exists(select 1 from jsonb_to_recordset($2::jsonb) as k("requestId" text,id text) where k."requestId"=request_id and k.id=activity_id)`,
    [conversationId, JSON.stringify(keys)])).rows : []
    return { ...page, itemProvenance: Object.fromEntries(rows.map((row) => [conversationActivityKey(row.request_id, row.activity_id), row.source_provenance])) }
  }

  async unfinished(conversationId: string, query: Queryable = this.pool): Promise<{ activities: OperatorActivity[]; hasMore: boolean }> {
    const limit = 100
    const result = await query.query<{ record: unknown; sequence: string; revision: string }>(`
      select record,sequence::text,revision::text from operator_conversation_activity
      where conversation_id=$1 and record->>'kind' <> 'thinking' and record->>'status' in ('pending','running','unknown')
      order by sequence limit $2`, [conversationId, limit + 1])
    return { activities: result.rows.slice(0, limit).map((row) => OperatorActivitySchema.parse({ ...(row.record as object), sequence: row.sequence, revision: Number(row.revision) })),
      hasMore: result.rows.length > limit }
  }

  async unfinishedOwners(kind: 'agent' | 'operator', conversationId?: string) {
    const rows = (await this.pool.query<{ conversation_id: string; request_id: string; activity_id: string; native: unknown; owner_native: unknown }>(`
      select a.conversation_id,a.request_id,a.activity_id,a.source_provenance->'native' as native,a.source_provenance->'ownerNative' as owner_native
      from operator_conversation_activity a join operator_conversations c on c.id=a.conversation_id
        join operator_conversation_turns t on t.conversation_id=a.conversation_id and t.request_id=a.request_id
      where c.kind=$1 and ($2::text is null or c.id=$2) and c.deleted_at is null and a.record->>'kind'<>'thinking' and a.record->>'status' in ('pending','running','unknown')
        and a.source_provenance#>>'{ownerNative,turnId}' is not null
        and a.source_provenance->>'ownerInputHash'=t.input_hash
      order by a.sequence limit 101`, [kind, conversationId ?? null])).rows
    return { owners: rows.slice(0, 100).flatMap((row) => {
      const native = ActivityNativeIdentitySchema.safeParse(row.native), owner = ActivityNativeIdentitySchema.safeParse(row.owner_native)
      return native.success && owner.success ? [{ conversationId: row.conversation_id, requestId: row.request_id, activityId: row.activity_id,
        native: native.data, ownerNative: owner.data }] : []
    }), hasMore: rows.length > 100 }
  }

  async finish(conversationId: string, requestId: string, canceled: boolean, query: Queryable): Promise<void> {
    // A terminal turn is not proof that every tool succeeded. Preserve missing
    // completion evidence explicitly instead of painting all entries successful.
    await query.query(`update operator_conversation_activity set revision=revision+1,
      record=jsonb_set(record,'{status}',to_jsonb(case when record->>'kind'='thinking' then case when $3 then 'canceled' else 'completed' end else 'unknown' end::text))
      where conversation_id=$1 and request_id=$2 and record->>'status' in ('pending','running')`, [conversationId, requestId, canceled])
  }
}
