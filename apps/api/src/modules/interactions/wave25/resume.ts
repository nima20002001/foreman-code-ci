import { DurableInteractionSchema, type DurableInteraction } from '@foreman-code/contracts'
import { GraphFactSchema, GraphInteractionSchema, assertNativeGraphProjectionAuthority,
  type GraphEffect, type GraphEvidence, type GraphFact } from '@foreman-code/contracts/wave25'
import type pg from 'pg'
import type { GraphResumeClaim } from '../deliveryPostgres.js'
import { INTERACTION_DELIVERY_LEASE_MS } from '../delivery.js'
import { graphSourceDigest, type RunGraphPublication } from '../../run-graph/publication.js'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import type { NativeGraphProjectionGuard } from '../../run-graph/records.js'
import { transact } from './transaction.js'
import { fail, identity, lockInteraction, readContext, requireLeaseAtCommit } from './context.js'
import { decisionDigest, interactionFact, nextInteraction, writeInteraction } from './publication.js'
import { approvalAttentionFacts } from './attention.js'
import { approvalAckRecord, assertWorkflowApprovalAckLocked } from '../nativeApprovalProof.js'
import { componentLogger } from '../../diagnostics/logger.js'
import { leaseFailureCause, renewOwnedLeases } from '../../leases/ownerLeases.js'

const RESUME_CLAIM_RENEWAL_WINDOW_MS = 40_000

interface ResumeRow { lease_expires_at: Date | null; last_error: string | null; state: string; lease_token: string | null; lease_fence: string; revision: string; live: boolean;
  approval_dispatch_started_at: Date | null; approval_native_ack_id: string | null }
async function resumeRow(sql: GraphTransactionSql, id: string): Promise<ResumeRow | undefined> {
  return (await sql.query<ResumeRow>(`select lease_expires_at,last_error,state,lease_token,lease_fence::text,revision::text,
    coalesce(lease_expires_at>clock_timestamp(),false) as live,approval_dispatch_started_at,approval_native_ack_id
    from interaction_graph_resumes where interaction_id=$1 for update`, [id])).rows[0]
}
function resumeDigest(i: DurableInteraction): string {
  return graphSourceDigest({ interactionId: i.id, runId: i.runId, executionId: i.executionId,
    graphThreadId: i.graphThreadId, graphInterruptId: i.graphInterruptId ?? null, decision: decisionDigest(i) })
}
async function consumed(sql: GraphTransactionSql, i: DurableInteraction): Promise<boolean> {
  const receipt = (await sql.query<{ effect_digest: string }>(
    "select effect_digest from run_graph_effects where run_id=$1 and effect_kind='graph.resume' and entity_id=$2", [i.runId, i.id])).rows[0]
  if (receipt && receipt.effect_digest !== resumeDigest(i)) return fail('GRAPH_EFFECT_CONFLICT')
  return !!receipt
}

/** Normal terminal publication is downstream of the exact selected approval,
 * not an alternative way to consume it. Call on the Run owner's transaction
 * AFTER the parent/head and execution locks. No native I/O or invented ack is
 * allowed here; the existing native projection writer alone qualifies the ack.
 * Stop/abnormal negative settlement deliberately does not use this gate.
 */
export async function assertApprovalTerminalSettlement(sql: GraphTransactionSql, runId: string,
  executionId?: string): Promise<void> {
  const rows = (await sql.query<{ id: string; execution_id: string; record: unknown }>(`select id,execution_id,record
    from durable_interactions where run_id=$1 and ($2::text is null or execution_id=$2)
      and record->>'selectedOptionId' is not null order by id limit 1001 for update`, [runId, executionId ?? null])).rows
  if (rows.length > 1000) return fail('GRAPH_RESUME_LIMIT')
  for (const stored of rows) {
    const i = DurableInteractionSchema.parse(stored.record)
    if (i.id !== stored.id || i.executionId !== stored.execution_id || i.runId !== runId
      || i.graphThreadId !== runId) return fail('APPROVAL_IDENTITY_MISMATCH')
    if (i.kind === 'work_direction') {
      if (i.status !== 'delivered') return fail('WORK_DIRECTION_WAIT_CONFLICT')
      continue
    }
    // Acceptance may follow legitimate exact-session cleanup. These durable
    // receipts are settlement evidence, NOT a fresh native/credential authority.
    // The caller separately arbitrates Stop under its Run-owner lock.
    await assertWorkflowApprovalAckLocked(sql, i)
    const row = await resumeRow(sql, i.id)
    if (i.status !== 'delivered' || i.deliveryState !== 'delivered' || !i.graphInterruptId
      || row?.state !== 'resumed' || !row.approval_native_ack_id || !await consumed(sql, i)) {
      return fail('APPROVAL_SETTLEMENT_PENDING',
        'The selected approval still needs exact delivery, checkpoint consumption and native acknowledgement. Native work was not replayed.')
    }
  }
}

/** Lease the existing outbox. Unknown old callbacks are NOT replayed automatically.
 * The atomic consumer below may safely be retried by the qualified Run owner. */
export async function claimResume(pool: pg.Pool, runId: string, id: string, token: string,
  atomicCheckpointConsumer = false): Promise<GraphResumeClaim | undefined> {
  return transact(pool, runId, async (publication) => {
    const sql = publication.sql, i = await lockInteraction(sql, id)
    if (await consumed(sql, i)) return undefined
    const context = await readContext(sql, i)
    if (i.deliveryState !== 'delivered' || i.status === 'canceled' || context.stopped || !i.graphInterruptId) return undefined
    if (i.approval.handler === 'orchestrator' && !(await sql.query(
      "select 1 from review_jobs where interaction_id=$1 and state='completed'", [id])).rowCount) return undefined
    const row = await resumeRow(sql, id)
    if (!row || row.live || row.state === 'canceled' || row.state === 'resumed' || row.last_error === 'GRAPH_RESUME_RECEIPT_MISSING') return undefined
    if (await consumed(sql, i)) {
      await sql.query(`update interaction_graph_resumes set state='resumed',completed_at=coalesce(completed_at,clock_timestamp()),
        lease_owner=null,lease_token=null,lease_expires_at=null where interaction_id=$1`, [id])
      return undefined
    }
    if (row.approval_dispatch_started_at && !atomicCheckpointConsumer) {
      await sql.query(`update interaction_graph_resumes set state='blocked',lease_owner=null,lease_token=null,lease_expires_at=null,
        last_error='GRAPH_RESUME_RECONCILIATION_REQUIRED',updated_at=clock_timestamp() where interaction_id=$1`, [id])
      return undefined
    }
    const result = await sql.query(`update interaction_graph_resumes set state='resuming',lease_owner=$2,lease_token=$2,
      lease_fence=lease_fence+1,revision=revision+1,attempt=attempt+1,graph_interrupt_id=$4,
      approval_dispatch_started_at=coalesce(approval_dispatch_started_at,clock_timestamp()),
      lease_expires_at=clock_timestamp()+($3::integer*interval '1 millisecond'),updated_at=clock_timestamp()
      where interaction_id=$1 and (lease_expires_at is null or lease_expires_at<=clock_timestamp())`,
    [id, token, INTERACTION_DELIVERY_LEASE_MS, i.graphInterruptId])
    return result.rowCount === 1 ? { interaction: i, ownerToken: token } : undefined
  })
}
export async function renewResume(pool: pg.Pool, claim: GraphResumeClaim): Promise<void> {
  const result = await pool.query(`update interaction_graph_resumes g set lease_expires_at=clock_timestamp()+($3::integer*interval '1 millisecond')
    from runs r where g.interaction_id=$1 and g.lease_token=$2 and g.state='resuming' and g.lease_expires_at>clock_timestamp()
      and r.id=g.run_id and r.stop_requested_at is null and r.execution_state in ('running','waiting','queued')`,
  [claim.interaction.id, claim.ownerToken, INTERACTION_DELIVERY_LEASE_MS])
  if (result.rowCount !== 1) return fail('GRAPH_RESUME_OWNER_LOST')
}
/** Renews claims while their claimant waits for the Run owner (queued behind other work on the Run). Renewal
 * stops when `release` runs, before the owner transaction locks the claim rows, or when the claimant ends.
 * A claim's commit stays fenced by its lease expiry; a failed renewal is logged with its real cause. */
export function holdResumeClaims(delivery: { renewGraphResume(claim: GraphResumeClaim): Promise<void> },
  claims: readonly GraphResumeClaim[], claimedAt: number): GraphResumeClaim[] {
  if (!claims.length) return []
  const owner = new AbortController()
  const stop = renewOwnedLeases({ signal: owner.signal,
    leases: claims.map(claim => {
      let expiresAt = claimedAt + INTERACTION_DELIVERY_LEASE_MS
      return { name: 'graph resume claim', renewWithinMs: RESUME_CLAIM_RENEWAL_WINDOW_MS,
        remainingMs: () => expiresAt - Date.now(),
        renew: async () => {
          const started = Date.now()
          await delivery.renewGraphResume(claim)
          expiresAt = started + INTERACTION_DELIVERY_LEASE_MS
        } }
    }),
    onFailure: (error, phase) => componentLogger('engine').warn({ operation: 'renew graph resume claim', phase,
      interactionIds: claims.map(claim => claim.interaction.id), cause: leaseFailureCause(error) },
    'Graph resume claim renewal stopped'),
  })
  const release = async () => { owner.abort(); await stop() }
  return claims.map(claim => ({ interaction: claim.interaction, ownerToken: claim.ownerToken, release }))
}
export async function finishResume(pool: pg.Pool, claim: GraphResumeClaim, error?: string): Promise<void> {
  await transact(pool, claim.interaction.runId, async (publication) => {
    const sql = publication.sql, i = await lockInteraction(sql, claim.interaction.id), row = await resumeRow(sql, i.id)
    if (await consumed(sql, i)) return // The atomic consumer already committed and released the intent.
    if (!row?.live || row.lease_token !== claim.ownerToken) return fail('GRAPH_RESUME_OWNER_LOST')
    await sql.query(`update interaction_graph_resumes set state='blocked',lease_owner=null,lease_token=null,lease_expires_at=null,
      last_error=$2,updated_at=clock_timestamp() where interaction_id=$1`,
    [i.id, error ? 'GRAPH_RESUME_CALLBACK_FAILED' : 'GRAPH_RESUME_RECEIPT_MISSING'])
    // A void callback is not durable checkpoint or native-resumption evidence.
  })
}

/** A3/terminal calls this inside the existing exclusive checkpoint transaction.
 * writeCheckpoint is SQL ONLY. It must not launch/reattach/respond to a provider.
 * The graph.resume receipt and exact checkpoint consume commit together, so a
 * crash before/after the caller returns cannot consume the interrupt twice. */
export async function consumeApprovalGraphResume(publication: RunGraphPublication, claim: GraphResumeClaim,
  writeCheckpoint: (sql: GraphTransactionSql, interaction: DurableInteraction) => Promise<void>): Promise<{ replayed: boolean }> {
  const sql = publication.sql, i = await lockInteraction(sql, claim.interaction.id)
  if (publication.scope.runId !== i.runId) return fail('GRAPH_SCOPE_MISMATCH')
  if (await consumed(sql, i)) return { replayed: true }
  const context = await readContext(sql, i, true), row = await resumeRow(sql, i.id)
  if (!row?.live || row.lease_token !== claim.ownerToken || row.state !== 'resuming'
    || i.deliveryState !== 'delivered' || i.status !== 'delivered' || !i.graphInterruptId) return fail('GRAPH_RESUME_OWNER_LOST')
  if (!row.lease_expires_at) return fail('GRAPH_RESUME_OWNER_LOST')
  requireLeaseAtCommit(sql, row.lease_expires_at, 'GRAPH_RESUME_OWNER_LOST')
  const next = nextInteraction(i, {}), effect: GraphEffect = { identity: { kind: 'graph.resume', entityId: i.id }, digest: resumeDigest(i) }
  await publication.effect({ effect, evidence: { sourceKind: 'delivery', sourceId: i.id, sourceRevision: String(next.revision) },
    sourceDigest: graphSourceDigest({ interaction: next, graphInterruptId: i.graphInterruptId }), facts: [interactionFact(context, next, 'pending')] },
  { expected: { scope: context.scope, effect: effect.identity, effectDigest: effect.digest,
    ownerId: claim.ownerToken, fence: row.lease_fence, connectionGeneration: null },
    readCurrentLocked: async (transaction) => {
      const actual = await lockInteraction(transaction, i.id), owner = await resumeRow(transaction, i.id)
      const authority = await readContext(transaction, actual, true)
      if (!owner) return fail('GRAPH_RESUME_OWNER_LOST')
      return { scope: authority.scope, effect: { kind: 'graph.resume', entityId: actual.id }, effectDigest: resumeDigest(actual),
        ownerId: owner.lease_token ?? 'lost', fence: owner.lease_fence, connectionGeneration: null,
        ownership: owner.live ? 'held' : 'lost', access: 'effect', security: 'valid',
        effectClosed: owner.state === 'canceled' || actual.status !== 'delivered', submission: 'settled' }
    } }, async (transaction) => {
    await writeCheckpoint(transaction, i)
    await writeInteraction(transaction, i, next)
    await transaction.query(`update interaction_graph_resumes set state='resumed',revision=revision+1,completed_at=clock_timestamp(),
      lease_owner=null,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where interaction_id=$1`, [i.id])
  })
  return { replayed: false }
}

/** A5 calls only for its qualified exact native continuation acknowledgment.
 * Transport events, the delivery receipt and checkpoint return cannot call this
 * path on their own. The frozen projection guard is checked against live SQL. */
export async function recordWorkerResumption(publication: RunGraphPublication,
  supplied: Extract<GraphFact, { type: 'worker.resumed' }>, source: GraphEvidence,
  guard: NativeGraphProjectionGuard, originalProofId: string): Promise<void> {
  const fact = GraphFactSchema.parse(supplied)
  if (fact.type !== 'worker.resumed' || source.sourceKind !== 'native_event') return fail('GRAPH_EVIDENCE_INVALID')
  const sql = publication.sql, i = await lockInteraction(sql, fact.interactionId), context = await readContext(sql, i)
  if (context.stopped) return fail('GRAPH_STOP_CONFLICT')
  if (i.status !== 'delivered' || i.deliveryState !== 'delivered'
    || graphSourceDigest(identity(context.requester)) !== graphSourceDigest(fact.requester)
    || guard.expected.key.workKind !== 'workflow' || guard.expected.key.workId !== i.executionId) return fail('GRAPH_SCOPE_MISMATCH')
  assertNativeGraphProjectionAuthority(guard.expected,
    await guard.readCurrentLocked(sql, publication.scope, guard.expected.key))
  const row = await resumeRow(sql, i.id)
  if (!row || row.state !== 'resumed' || !await consumed(sql, i)) return fail('GRAPH_RESUME_RECEIPT_MISSING')
  if (row.approval_native_ack_id) {
    // Repeated complete histories retain the FIRST immutable acknowledgement.
    // A newer source is not permission to retarget that receipt.
    await assertWorkflowApprovalAckLocked(sql, i)
    return
  }
  const next = nextInteraction(i, {})
  const base = interactionFact(context, next, 'pending')
  if (base.type !== 'interaction.state') return fail('GRAPH_INVALID_FACT')
  const attention = await approvalAttentionFacts(sql, context, { interaction: next, nativeAcknowledged: true })
  const evidence: GraphEvidence = { sourceKind: 'native_event', sourceId: i.id, sourceRevision: String(next.revision) }
  const sourceDigest = graphSourceDigest({ next, source, fact })
  const facts: GraphFact[] = [fact, { type: 'interaction.state',
    interaction: GraphInteractionSchema.parse({ ...base.interaction, resumeState: 'acknowledged',
      resumeAcknowledgementId: fact.acknowledgementId }) },
    { type: 'exchange.retired', exchangeKind: 'interaction', exchangeId: i.id, finalRevision: String(next.revision) },
    ...attention]
  const record = await approvalAckRecord(sql, next, { proofId: originalProofId, source,
    requester: fact.requester, acknowledgementId: fact.acknowledgementId,
    publication: { evidence, sourceDigest, semanticDigest: graphSourceDigest(facts.map((item) => GraphFactSchema.parse(item))) } })
  await publication.source({ evidence, sourceDigest, facts }, async (transaction) => {
    await writeInteraction(transaction, i, next)
    await transaction.query(`update interaction_graph_resumes set approval_native_ack_id=$2,approval_native_ack_source=$3::jsonb,
      approval_native_ack_record=$4::jsonb,revision=revision+1,updated_at=clock_timestamp() where interaction_id=$1`,
    [i.id, fact.acknowledgementId, JSON.stringify(source), JSON.stringify(record)])
  })
  await assertWorkflowApprovalAckLocked(sql, next)
}
